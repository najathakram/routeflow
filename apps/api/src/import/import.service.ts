import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { parse } from "csv-parse/sync";
import { InvoiceStatus, UserRole } from "@prisma/client";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";

/** Category name substrings (lower-cased) that map to the INVENTORY_PURCHASE system code */
const INVENTORY_PURCHASE_KEYWORDS = [
  "inventor", // "inventory", "inventory purchase", "inventory purchases"
  "stock purchase",
  "purchase of stock",
  "purchase of goods",
  "cost of goods",
  "goods purchase",
];

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vendorBillsService: VendorBillsService,
  ) {}

  private parseCsv(buffer: Buffer): any[] {
    try {
      return parse(buffer.toString("utf8"), {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        relax_quotes: true,
        trim: true,
      });
    } catch (e) {
      this.logger.error("CSV parse error", e);
      return [];
    }
  }

  private generateTempPassword(): string {
    return crypto.randomBytes(6).toString("hex");
  }

  private mapPaymentMethod(method: string): string {
    const m = (method || "").toLowerCase().trim();
    if (m === "cash") return "CASH";
    if (m === "check" || m === "cheque") return "CHECK";
    if (m === "zelle" || m === "ach" || m === "wire") return "ACH";
    return "OTHER";
  }

  private mapInvoiceStatus(zohoStatus: string): InvoiceStatus {
    const s = (zohoStatus || "").toLowerCase().trim();
    if (s === "closed" || s === "paid") return InvoiceStatus.PAID;
    if (s === "overdue") return InvoiceStatus.OVERDUE;
    if (s === "draft") return InvoiceStatus.DRAFT;
    if (s.includes("partial")) return InvoiceStatus.PARTIAL;
    if (s === "void" || s === "voided") return InvoiceStatus.VOID;
    if (s === "write off" || s === "write-off" || s === "written off" || s === "written-off")
      return InvoiceStatus.WRITTEN_OFF;
    if (s === "sent" || s === "open") return InvoiceStatus.SENT;
    return InvoiceStatus.SENT;
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 30);
  }

  /**
   * Extracts the vendor/supplier name from a CSV row, checking all common
   * Zoho column names in priority order:
   * Zoho Expense → "Merchant Name"
   * Zoho Books   → "Vendor Name" | "Customer Name"
   * Generic      → "Payee" | "Supplier Name" | "Company Name"
   */
  private getVendorName(row: any): string {
    return (
      row["Merchant Name"] ||
      row["Vendor Name"] ||
      row["Customer Name"] ||
      row["Payee"] ||
      row["Supplier Name"] ||
      row["Company Name"] ||
      ""
    ).trim();
  }

  /**
   * Builds a complete supplier data object for a given vendor name by:
   * 1. Extracting whatever detail columns are present in the CSV row
   * 2. Looking up a matching Customer contact by name (case-insensitive)
   * 3. Filling any remaining gaps from the customer record
   *
   * CSV columns always take priority over customer contact data.
   */
  private async buildSupplierData(name: string, csvRow: any): Promise<Record<string, any>> {
    const data: Record<string, any> = { name };

    // ── Layer 1: CSV columns ─────────────────────────────────────────────────
    const csv = {
      email: (csvRow["Vendor Email"] || csvRow["Email"] || "").trim(),
      phone: (csvRow["Vendor Phone"] || csvRow["Phone"] || "").trim(),
      mobile: (csvRow["Vendor Mobile"] || csvRow["Mobile"] || "").trim(),
      website: (csvRow["Vendor Website"] || csvRow["Website"] || "").trim(),
      contactName: (csvRow["Contact Name"] || csvRow["Vendor Contact"] || "").trim(),
      addressLine1: (
        csvRow["Vendor Address"] ||
        csvRow["Billing Address"] ||
        csvRow["Address"] ||
        ""
      ).trim(),
      city: (csvRow["Vendor City"] || csvRow["City"] || "").trim(),
      state: (csvRow["Vendor State"] || csvRow["State"] || "").trim(),
      zip: (csvRow["Vendor Zip"] || csvRow["Vendor ZIP"] || csvRow["Zip"] || "").trim(),
      country: (csvRow["Vendor Country"] || csvRow["Country"] || "").trim(),
    };
    for (const [k, v] of Object.entries(csv)) {
      if (v) data[k] = v;
    }

    // ── Layer 2: Customer contact match (fills gaps left by CSV) ─────────────
    const matchingCustomers = await this.prisma.forTenant().customer.findMany({
      where: {
        OR: [
          { businessName: { equals: name, mode: "insensitive" } },
          { displayName: { equals: name, mode: "insensitive" } },
          { contactName: { equals: name, mode: "insensitive" } },
        ],
      },
      include: { addresses: true },
    });

    if (matchingCustomers.length > 0) {
      const c = matchingCustomers[0];
      if (!data.phone && c.phone) data.phone = c.phone;
      if (!data.mobile && c.mobile) data.mobile = c.mobile;
      if (!data.email && c.email) data.email = c.email;
      if (!data.contactName && c.contactName) data.contactName = c.contactName;
      if (c.notes && !data.notes) data.notes = c.notes;

      // Address — only if CSV didn't provide one
      if (!data.addressLine1) {
        const addr = c.addresses.find((a) => a.addressType === "BILLING") ?? c.addresses[0];
        if (addr) {
          if (addr.line1) data.addressLine1 = addr.line1;
          if (addr.line2) data.addressLine2 = addr.line2;
          if (addr.city) data.city = addr.city;
          if (addr.state) data.state = addr.state;
          if (addr.zip) data.zip = addr.zip;
        }
      }
    }

    return data;
  }

  async importContacts(
    buffer: Buffer,
    userId: string,
  ): Promise<{ created: number; updated: number; skipped: number; errors: string[] }> {
    const rows = this.parseCsv(buffer);
    let created = 0,
      updated = 0,
      skipped = 0;
    const errors: string[] = [];

    for (const row of rows) {
      // Only import customer-type contacts (skip vendors etc.)
      const contactType = (row["Contact Type"] || "customer").toLowerCase().trim();
      if (contactType && contactType !== "customer") {
        skipped++;
        continue;
      }

      const name = (
        row["Customer Name"] ||
        row["Display Name"] ||
        row["Company Name"] ||
        ""
      ).trim();
      if (!name) {
        skipped++;
        continue;
      }

      const zohoContactId = (row["Customer ID"] || "").trim() || null;

      // Extract all fields from CSV
      const displayName = (row["Display Name"] || "").trim() || null;
      const salutation = (row["Salutation"] || "").trim() || null;
      const firstName = (row["First Name"] || "").trim() || null;
      const lastName = (row["Last Name"] || "").trim() || null;
      // Main phone from Phone column (preferred), fallback to Billing Phone
      const phone =
        (row["Phone"] || row["Billing Phone"] || "").replace(/^'+/, "").replace(/'+/g, "").trim() ||
        null;
      // Mobile from MobilePhone column
      const mobile =
        (row["MobilePhone"] || "").replace(/^'+/, "").replace(/'+/g, "").trim() || null;
      const csvEmail = (row["EmailID"] || row["Email"] || "").trim().toLowerCase() || null;
      const currency = (row["Currency Code"] || "USD").trim() || "USD";
      const notes = (row["Notes"] || "").trim() || null;

      // Contact name: First+Last, or Billing Attention, or business name
      const contactName =
        [firstName, lastName].filter(Boolean).join(" ").trim() ||
        (row["Billing Attention"] || "").trim() ||
        name;

      // Billing address fields
      const billingLine1 = [row["Billing Address"], row["Billing Street2"]]
        .filter(Boolean)
        .join(", ")
        .trim();
      const billingCity = (row["Billing City"] || "").trim();
      const billingState = (row["Billing State"] || "").trim();
      const billingZip = (row["Billing Code"] || "").trim();
      const billingLatRaw = parseFloat(row["Billing Latitude"] || "");
      const billingLngRaw = parseFloat(row["Billing Longitude"] || "");
      const billingLat = isNaN(billingLatRaw) ? null : billingLatRaw;
      const billingLng = isNaN(billingLngRaw) ? null : billingLngRaw;
      const hasBilling = !!(billingLine1 || billingCity);

      // Shipping address fields
      const shippingLine1 = [row["Shipping Address"], row["Shipping Street2"]]
        .filter(Boolean)
        .join(", ")
        .trim();
      const shippingCity = (row["Shipping City"] || "").trim();
      const shippingState = (row["Shipping State"] || "").trim();
      const shippingZip = (row["Shipping Code"] || "").trim();
      const shippingLatRaw = parseFloat(row["Shipping Latitude"] || "");
      const shippingLngRaw = parseFloat(row["Shipping Longitude"] || "");
      const shippingLat = isNaN(shippingLatRaw) ? null : shippingLatRaw;
      const shippingLng = isNaN(shippingLngRaw) ? null : shippingLngRaw;
      // Only create shipping if it has data and differs from billing
      const hasShipping =
        !!(shippingLine1 || shippingCity) &&
        (shippingLine1 !== billingLine1 ||
          shippingCity !== billingCity ||
          shippingZip !== billingZip);

      // Find existing customer: prefer Zoho ID match, then fall back to
      // case-insensitive businessName match for customers imported before
      // zohoContactId tracking was wired up.
      let existing = zohoContactId
        ? await this.prisma.forTenant().customer.findFirst({
            where: { zohoContactId },
            include: { addresses: true, contactPersons: true },
          })
        : null;
      if (!existing) {
        existing = await this.prisma.forTenant().customer.findFirst({
          where: { businessName: { equals: name, mode: "insensitive" } },
          include: { addresses: true, contactPersons: true },
        });
      }

      if (existing) {
        // Update the existing customer with any missing/new fields
        try {
          await this.prisma.forTenant().customer.update({
            where: { id: existing.id },
            data: {
              ...(zohoContactId && !existing.zohoContactId && { zohoContactId }),
              ...(displayName !== null && { displayName }),
              ...(salutation !== null && { salutation }),
              ...(firstName !== null && { firstName }),
              ...(lastName !== null && { lastName }),
              ...(phone !== null && !existing.phone && { phone }),
              ...(mobile !== null && { mobile }),
              ...(csvEmail !== null && { email: csvEmail }),
              ...(notes !== null && { notes }),
              currency,
              contactName:
                existing.contactName === existing.businessName
                  ? contactName || existing.contactName
                  : existing.contactName,
            },
          });

          // Add billing address if not already present
          const existingBilling = existing.addresses.find((a) => a.addressType === "BILLING");
          if (!existingBilling && hasBilling) {
            await this.prisma.forTenant().customerAddress.create({
              data: {
                customerId: existing.id,
                label: "Billing",
                line1: billingLine1 || billingCity || "Unknown",
                city: billingCity || "Unknown",
                state: billingState || "Unknown",
                zip: billingZip || "00000",
                lat: billingLat,
                lng: billingLng,
                addressType: "BILLING",
                isDefault: true,
              },
            });
          }

          // Add shipping address if not already present and differs from billing
          const existingShipping = existing.addresses.find((a) => a.addressType === "SHIPPING");
          if (!existingShipping && hasShipping) {
            await this.prisma.forTenant().customerAddress.create({
              data: {
                customerId: existing.id,
                label: "Shipping",
                line1: shippingLine1 || shippingCity || "Unknown",
                city: shippingCity || "Unknown",
                state: shippingState || "Unknown",
                zip: shippingZip || "00000",
                lat: shippingLat,
                lng: shippingLng,
                addressType: "SHIPPING",
                isDefault: false,
              },
            });
          }

          // Add contact person if we have a name and none exists yet
          if ((firstName || lastName) && existing.contactPersons.length === 0) {
            await this.prisma.forTenant().contactPerson.create({
              data: {
                customerId: existing.id,
                salutation: salutation || null,
                firstName: firstName || contactName,
                lastName: lastName || null,
                email: csvEmail || null,
                phone: phone || null,
                mobile: mobile || null,
                isPrimary: true,
              },
            });
          }

          updated++;
        } catch (e: any) {
          errors.push(`${name} (update): ${e.message}`);
        }
        continue;
      }

      // Generate a unique username from business name
      const baseUsername = this.slugify(name);
      let username = baseUsername;
      let suffix = 1;
      while (await this.prisma.forTenant().user.findFirst({ where: { username } })) {
        username = `${baseUsername}_${suffix++}`;
      }

      // Determine user email: use CSV email if not taken, otherwise synthetic
      let userEmail: string;
      if (csvEmail) {
        const emailTaken = await this.prisma
          .forTenant()
          .user.findFirst({ where: { email: csvEmail } });
        userEmail = emailTaken ? `${username}@imported.local` : csvEmail;
      } else {
        userEmail = `${username}@imported.local`;
      }

      try {
        const hashedPassword = await bcrypt.hash(this.generateTempPassword(), 10);

        await this.prisma.tenantTransaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              email: userEmail,
              username,
              password: hashedPassword,
              role: UserRole.CUSTOMER,
              forcePasswordChange: true,
            },
          });

          const customer = await tx.customer.create({
            data: {
              userId: user.id,
              businessName: name,
              contactName: contactName || name,
              displayName: displayName || null,
              salutation: salutation || null,
              firstName: firstName || null,
              lastName: lastName || null,
              phone: phone || null,
              mobile: mobile || null,
              email: csvEmail || null,
              currency,
              notes: notes || null,
              zohoContactId: zohoContactId || null,
            },
          });

          // Billing address
          if (hasBilling) {
            await tx.customerAddress.create({
              data: {
                customerId: customer.id,
                label: "Billing",
                line1: billingLine1 || billingCity || "Unknown",
                city: billingCity || "Unknown",
                state: billingState || "Unknown",
                zip: billingZip || "00000",
                lat: billingLat,
                lng: billingLng,
                addressType: "BILLING",
                isDefault: true,
              },
            });
          }

          // Shipping address (only if different from billing)
          if (hasShipping) {
            await tx.customerAddress.create({
              data: {
                customerId: customer.id,
                label: "Shipping",
                line1: shippingLine1 || shippingCity || "Unknown",
                city: shippingCity || "Unknown",
                state: shippingState || "Unknown",
                zip: shippingZip || "00000",
                lat: shippingLat,
                lng: shippingLng,
                addressType: "SHIPPING",
                isDefault: false,
              },
            });
          }

          // Create contact person entry if we have a name
          if (firstName || lastName) {
            await tx.contactPerson.create({
              data: {
                customerId: customer.id,
                salutation: salutation || null,
                firstName: firstName || contactName,
                lastName: lastName || null,
                email: csvEmail || null,
                phone: phone || null,
                mobile: mobile || null,
                isPrimary: true,
              },
            });
          }
        });

        created++;
      } catch (e: any) {
        // P2002 = unique constraint violation — the customer (or their user account)
        // already exists in the database. Treat as a silent skip rather than an error
        // so re-importing the same CSV doesn't flood the UI with noise.
        if (e?.code === "P2002") {
          skipped++;
        } else {
          errors.push(`${name}: ${e.message}`);
          skipped++;
        }
      }
    }
    return { created, updated, skipped, errors };
  }

  async importInvoices(
    buffer: Buffer,
    userId: string,
  ): Promise<{ imported: number; updated: number; skipped: number; errors: string[] }> {
    const rows = this.parseCsv(buffer);
    let imported = 0,
      updated = 0,
      skipped = 0;
    const errors: string[] = [];

    // Group by Invoice ID
    const groups: Record<string, any[]> = {};
    for (const row of rows) {
      const id = row["Invoice ID"] || row["Invoice Number"];
      if (!id) continue;
      if (!groups[id]) groups[id] = [];
      groups[id].push(row);
    }

    const year = new Date().getFullYear();
    let seq = 1;

    for (const [, invoiceRows] of Object.entries(groups)) {
      const first = invoiceRows[0];
      const customerName = (first["Customer Name"] || first["Company Name"] || "").trim();
      if (!customerName) {
        skipped++;
        continue;
      }

      // Try to find existing customer
      let customer = await this.prisma.forTenant().customer.findFirst({
        where: { businessName: { contains: customerName, mode: "insensitive" } },
      });

      // Auto-create customer if not found
      if (!customer) {
        const baseUsername = this.slugify(customerName);
        let username = baseUsername;
        let usernameSeq = 1;
        while (await this.prisma.forTenant().user.findFirst({ where: { username } })) {
          username = `${baseUsername}_${usernameSeq++}`;
        }
        const userEmail = `${username}@imported.local`;
        const existingUser = await this.prisma.forTenant().user.findFirst({
          where: { OR: [{ email: userEmail }, { username }] },
        });
        if (existingUser) {
          skipped++;
          errors.push(`${customerName}: user conflict, skipped`);
          continue;
        }
        try {
          const hashedPassword = await bcrypt.hash(this.generateTempPassword(), 10);
          const street = (first["Billing Address"] || first["Billing Street"] || "").trim();
          const city = (first["Billing City"] || "").trim();
          const state = (first["Billing State"] || "").trim();
          const zip = (first["Billing Code"] || "").trim();
          const phone = (first["Billing Phone"] || "").replace(/['+]/g, "").trim();

          await this.prisma.tenantTransaction(async (tx) => {
            const user = await tx.user.create({
              data: {
                email: userEmail,
                username,
                password: hashedPassword,
                role: UserRole.CUSTOMER,
                forcePasswordChange: true,
              },
            });
            customer = await tx.customer.create({
              data: {
                userId: user.id,
                businessName: customerName,
                contactName: customerName,
                phone: phone || null,
              },
            });
            if (street || city) {
              await tx.customerAddress.create({
                data: {
                  customerId: customer!.id,
                  label: "default",
                  line1: street || city || "Unknown",
                  city: city || "Unknown",
                  state: state || "Unknown",
                  zip: zip || "00000",
                  isDefault: true,
                },
              });
            }
          });
        } catch (e: any) {
          skipped++;
          errors.push(`${customerName}: ${e.message}`);
          continue;
        }
      }

      if (!customer) {
        skipped++;
        continue;
      }

      const total = parseFloat(first["Total"] || "0") || 0;
      const subtotal = parseFloat(first["SubTotal"] || first["Sub Total"] || "0") || total;
      const discount =
        parseFloat(first["Entity Discount Amount"] || first["Discount Amount"] || "0") || 0;
      const shippingFee = parseFloat(first["Shipping Charge"] || "0") || 0;
      const invoiceNumber =
        first["Invoice Number"] || `INV-${year}-${String(seq++).padStart(4, "0")}`;
      const notes = first["Notes"] || null;
      const terms = first["Terms & Conditions"] || null;

      let issueDate = new Date();
      let dueDate: Date | null = null;
      let paidDate: Date | null = null;
      try {
        if (first["Invoice Date"]) issueDate = new Date(first["Invoice Date"]);
      } catch (_e) {
        /* ignore */
      }
      try {
        if (first["Due Date"]) dueDate = new Date(first["Due Date"]);
      } catch (_e) {
        /* ignore */
      }
      try {
        const pd = first["Payment Date"] || first["Last Payment Date"];
        if (pd) paidDate = new Date(pd);
      } catch (_e) {
        /* ignore */
      }

      // Determine status using Zoho's "Balance Due" field, which is more reliable
      // than the status label (Zoho may show "Overdue" for invoices paid in cash outside the system)
      const zohoStatus = this.mapInvoiceStatus(first["Invoice Status"]);
      const balanceDue = parseFloat(
        first["Balance Due"] || first["Balance"] || first["Outstanding Amount"] || "NaN",
      );

      let status: InvoiceStatus;
      if (zohoStatus === InvoiceStatus.DRAFT) {
        status = InvoiceStatus.DRAFT;
      } else if (zohoStatus === InvoiceStatus.VOID) {
        status = InvoiceStatus.VOID;
      } else if (zohoStatus === InvoiceStatus.WRITTEN_OFF) {
        status = InvoiceStatus.WRITTEN_OFF;
      } else if (!isNaN(balanceDue) && total > 0 && balanceDue <= 0.01) {
        // Balance is effectively zero → fully paid, regardless of what Zoho shows
        status = InvoiceStatus.PAID;
      } else if (!isNaN(balanceDue) && total > 0 && balanceDue < total - 0.01) {
        // Partial payment recorded
        status = InvoiceStatus.PARTIAL;
      } else {
        // No balance info available — trust the Zoho status label
        status = zohoStatus;
      }

      const paidAt = status === InvoiceStatus.PAID ? paidDate || dueDate || issueDate : null;

      // Build line items; try to match product by SKU
      const itemsData: any[] = [];
      for (const row of invoiceRows) {
        const description = (row["Item Name"] || "").replace(/[\n\r]+/g, " ").trim() || "Item";
        const qty = parseFloat(row["Quantity"] || "1") || 1;
        if (qty <= 0) continue;
        const unitPrice = parseFloat(row["Item Price"] || "0") || 0;
        const itemDiscount = parseFloat(row["Discount Amount"] || "0") || 0;
        const sub = parseFloat(row["Item Total"] || "0") || qty * unitPrice - itemDiscount;
        const sku = (row["SKU"] || "").trim();

        let productId: string | undefined;
        if (sku) {
          const product = await this.prisma.forTenant().product.findFirst({
            where: { sku: { equals: sku, mode: "insensitive" } },
          });
          if (product) productId = product.id;
        }
        if (!productId && description && description !== "Item") {
          const product = await this.prisma.forTenant().product.findFirst({
            where: { name: { equals: description, mode: "insensitive" } },
          });
          if (product) productId = product.id;
        }

        itemsData.push({
          description,
          qty,
          unitPrice,
          discount: itemDiscount,
          taxRate: 0,
          subtotal: sub,
          ...(productId ? { productId } : {}),
        });
      }

      if (itemsData.length === 0) {
        itemsData.push({
          description: "Services",
          qty: 1,
          unitPrice: total,
          discount: 0,
          taxRate: 0,
          subtotal: total,
        });
      }

      try {
        // If the invoice already exists, only sync the Zoho-authoritative status
        // and dueDate. Totals/items/customer assignment are preserved so any
        // local edits aren't clobbered, but re-importing the same CSV will
        // repair any status drift (e.g. a Draft that got auto-flipped to
        // Overdue by an earlier buggy recalc).
        const existing = await this.prisma
          .forTenant()
          .invoice.findFirst({ where: { invoiceNumber } });
        if (existing) {
          const needsUpdate =
            existing.status !== status ||
            (existing.dueDate?.getTime() ?? 0) !== (dueDate?.getTime() ?? 0) ||
            (existing.paidAt?.getTime() ?? 0) !== (paidAt?.getTime() ?? 0);
          if (needsUpdate) {
            await this.prisma.forTenant().invoice.update({
              where: { id: existing.id },
              data: { status, dueDate, paidAt },
            });
            updated++;
          } else {
            skipped++;
          }
          continue;
        }

        const newInvoice = await this.prisma.forTenant().invoice.create({
          data: {
            invoiceNumber,
            customerId: customer.id,
            status,
            subtotal,
            taxAmount: 0,
            discount,
            shippingFee,
            total,
            issueDate,
            dueDate,
            paidAt,
            notes,
            terms,
            items: { create: itemsData },
          },
        });

        // For PAID/PARTIAL invoices, create a synthetic payment record so
        // balance-due calculations are correct without a separate payments import
        if (status === InvoiceStatus.PAID || status === InvoiceStatus.PARTIAL) {
          const paidAmount = !isNaN(balanceDue)
            ? total - balanceDue
            : status === InvoiceStatus.PAID
              ? total
              : 0;
          if (paidAmount > 0.01) {
            await this.prisma.forTenant().invoicePayment.create({
              data: {
                invoiceId: newInvoice.id,
                amount: paidAmount,
                method: "OTHER",
                reference: "zoho-import",
                notes: "Imported from Zoho",
                createdAt: paidAt || issueDate,
              },
            });
          }
        }

        imported++;
      } catch (e: any) {
        errors.push(`${invoiceNumber}: ${e.message}`);
        skipped++;
      }
    }
    return { imported, updated, skipped, errors };
  }

  async importPayments(
    buffer: Buffer,
    userId: string,
  ): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const rows = this.parseCsv(buffer);
    let imported = 0,
      skipped = 0;
    const errors: string[] = [];

    for (const row of rows) {
      const invoiceNumber = row["Invoice Number"];
      if (!invoiceNumber) {
        skipped++;
        continue;
      }

      const invoice = await this.prisma.forTenant().invoice.findFirst({ where: { invoiceNumber } });
      if (!invoice) {
        skipped++;
        continue;
      }

      const amount = parseFloat(row["Amount Applied to Invoice"] || row["Amount"] || "0");
      if (amount <= 0) {
        skipped++;
        continue;
      }

      const method = this.mapPaymentMethod(row["Mode"]) as any;
      const reference = row["Reference Number"] || null;
      let createdAt = new Date();
      try {
        if (row["Date"]) createdAt = new Date(row["Date"]);
      } catch (_e) {
        /* ignore */
      }

      // Zoho's InvoicePayment ID used as zohoId for deduplication
      const zohoPaymentId = (row["InvoicePayment ID"] || "").trim();

      try {
        // Skip if already imported (check by zohoId reference, or amount+date combo)
        if (zohoPaymentId) {
          const dup = await this.prisma.forTenant().invoicePayment.findFirst({
            where: { invoiceId: invoice.id, reference: zohoPaymentId },
          });
          if (dup) {
            skipped++;
            continue;
          }
        }

        // Also remove any synthetic "zoho-import" placeholder payment for this invoice
        // now that we have the real payment record
        await this.prisma.forTenant().invoicePayment.deleteMany({
          where: { invoiceId: invoice.id, reference: "zoho-import" },
        });

        await this.prisma.forTenant().invoicePayment.create({
          data: {
            invoiceId: invoice.id,
            amount,
            method,
            reference: zohoPaymentId || reference || null,
            notes: reference && reference !== zohoPaymentId ? reference : null,
            createdAt,
          },
        });
        imported++;
      } catch (e: any) {
        errors.push(`Payment for ${invoiceNumber}: ${e.message}`);
        skipped++;
      }
    }

    // Update invoice statuses based on total payments — wrapped in a single transaction.
    // DRAFT, VOID, and WRITTEN_OFF are deliberate user/system states that must NOT be
    // auto-flipped by the payment-based recalc — otherwise an unsent draft or a voided
    // invoice with a past due date would silently appear as OVERDUE in receivables.
    const allInvoices = await this.prisma
      .forTenant()
      .invoice.findMany({ include: { payments: true } });
    const now = new Date();
    const TERMINAL_STATUSES: InvoiceStatus[] = [
      InvoiceStatus.DRAFT,
      InvoiceStatus.VOID,
      InvoiceStatus.WRITTEN_OFF,
    ];
    const statusUpdates: Array<{ id: string; status: InvoiceStatus; paidAt: Date | null }> = [];
    for (const inv of allInvoices) {
      if (TERMINAL_STATUSES.includes(inv.status)) continue;
      const totalPaid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
      const total = Number(inv.total);
      let newStatus: InvoiceStatus;
      if (totalPaid >= total - 0.01) newStatus = InvoiceStatus.PAID;
      else if (totalPaid > 0) newStatus = InvoiceStatus.PARTIAL;
      else if (inv.dueDate && inv.dueDate < now) newStatus = InvoiceStatus.OVERDUE;
      else newStatus = inv.status;
      if (newStatus !== inv.status) {
        statusUpdates.push({
          id: inv.id,
          status: newStatus,
          paidAt: newStatus === InvoiceStatus.PAID ? now : null,
        });
      }
    }
    if (statusUpdates.length > 0) {
      await this.prisma.$transaction(
        statusUpdates.map((u) =>
          this.prisma.forTenant().invoice.update({
            where: { id: u.id },
            data: { status: u.status, paidAt: u.paidAt },
          }),
        ),
      );
    }

    return { imported, skipped, errors };
  }

  async importExpenses(
    buffer: Buffer,
    userId: string,
  ): Promise<{
    imported: number;
    skipped: number;
    errors: string[];
    suppliersCreated: number;
    suppliersUpdated: number;
    importBatchId: string;
  }> {
    const rows = this.parseCsv(buffer);
    let imported = 0,
      skipped = 0,
      suppliersCreated = 0,
      suppliersUpdated = 0;
    const errors: string[] = [];

    // Generate a unique batch ID for this import run so it can be rolled back later
    const importBatchId = crypto.randomUUID();

    // ── Step 1: Ensure expense categories exist ──────────────────────────────
    const catMap: Record<string, string> = {};
    // Also record which category IDs are INVENTORY_PURCHASE for vendor bill creation later
    const inventoryCatIds = new Set<string>();

    const catNames = [
      ...new Set(rows.map((r: any) => r["Expense Category"]).filter(Boolean)),
    ] as string[];
    for (const catName of catNames) {
      const nameLower = catName.toLowerCase();
      const isInventoryPurchase = INVENTORY_PURCHASE_KEYWORDS.some((kw) => nameLower.includes(kw));

      if (isInventoryPurchase) {
        // Always map to the canonical INVENTORY_PURCHASE system category
        let cat = await this.prisma
          .forTenant()
          .expenseCategory.findFirst({ where: { code: "INVENTORY_PURCHASE" } });
        if (!cat) {
          cat = await this.prisma.forTenant().expenseCategory.create({
            data: { name: "Inventory Purchase", code: "INVENTORY_PURCHASE", isCustom: false },
          });
        }
        catMap[catName] = cat.id;
        inventoryCatIds.add(cat.id);
        continue;
      }

      const code = catName
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "_")
        .slice(0, 20);
      let cat = await this.prisma
        .forTenant()
        .expenseCategory.findFirst({ where: { name: catName } });
      if (!cat) {
        try {
          cat = await this.prisma.forTenant().expenseCategory.create({
            data: { name: catName, code, isCustom: true },
          });
        } catch {
          try {
            cat = await this.prisma.forTenant().expenseCategory.create({
              data: { name: catName, code: code + "_Z", isCustom: true },
            });
          } catch (_e) {
            /* ignore */
          }
        }
      }
      if (cat) catMap[catName] = cat.id;
    }

    // ── Step 2: Auto-upsert suppliers from vendor column ─────────────────────
    // Zoho Expense uses "Merchant Name"; Zoho Books uses "Customer Name" or
    // "Vendor Name". getVendorName() checks all variants in priority order.
    const vendorMap: Record<string, string> = {}; // vendorName (lowercase) → supplierId

    // Group rows by vendor name to extract detail columns
    const vendorRowsMap: Record<string, any> = {};
    for (const row of rows) {
      const n = this.getVendorName(row);
      if (n && !vendorRowsMap[n.toLowerCase()]) {
        vendorRowsMap[n.toLowerCase()] = row; // keep first row per vendor
      }
    }

    const vendorNames = Object.keys(vendorRowsMap).map((k) => this.getVendorName(vendorRowsMap[k]));

    for (const name of vendorNames) {
      try {
        const sampleRow = vendorRowsMap[name.toLowerCase()];
        // Build full supplier profile: CSV columns + customer contact match
        const supplierData = await this.buildSupplierData(name, sampleRow);

        const existing = await this.prisma.forTenant().supplier.findFirst({
          where: { name: { equals: name, mode: "insensitive" } },
        });
        if (existing) {
          // Update — remove the 'name' key (not needed in update) and apply the rest
          const { name: _n, ...updateData } = supplierData;
          if (Object.keys(updateData).length > 0) {
            await this.prisma
              .forTenant()
              .supplier.update({ where: { id: existing.id }, data: updateData });
          }
          vendorMap[name.toLowerCase()] = existing.id;
          suppliersUpdated++;
        } else {
          const created = await this.prisma
            .forTenant()
            .supplier.create({ data: supplierData as any });
          vendorMap[name.toLowerCase()] = created.id;
          suppliersCreated++;
        }
      } catch (e: any) {
        errors.push(`Supplier "${name}": ${e.message}`);
      }
    }

    // ── Step 3: Ensure "Other" fallback category exists ─────────────────────
    // Used for rows that have no Expense Category or whose category could not
    // be created (e.g. due to a code-uniqueness clash).
    let otherCategoryId: string | null = null;
    {
      let otherCat = await this.prisma
        .forTenant()
        .expenseCategory.findFirst({ where: { code: "OTHER" } });
      if (!otherCat) {
        otherCat = await this.prisma.forTenant().expenseCategory.create({
          data: { name: "Other", code: "OTHER", isCustom: false },
        });
      }
      otherCategoryId = otherCat.id;
    }

    // ── Step 4: Import expense rows ──────────────────────────────────────────
    for (const row of rows) {
      const catName = row["Expense Category"];
      // Resolve category — fall back to "Other" instead of silently dropping the row
      const categoryId = (catName && catMap[catName]) || otherCategoryId;
      if (!categoryId) {
        skipped++;
        continue;
      }

      const amount = parseFloat(row["Total"] || row["Expense Amount"] || "0");
      if (amount <= 0) {
        skipped++;
        continue;
      }

      let date = new Date();
      try {
        if (row["Expense Date"]) date = new Date(row["Expense Date"]);
      } catch (_e) {
        /* ignore */
      }

      const referenceNumber = (row["Reference#"] || row["Reference Number"] || "").trim() || null;
      const description = row["Expense Description"] || referenceNumber || null;
      const notes = row["Notes"] || null;

      // Resolve supplier from the vendor name column (Merchant Name / Vendor Name / Customer Name …)
      const vendorName = this.getVendorName(row);
      const supplierId = vendorName ? (vendorMap[vendorName.toLowerCase()] ?? null) : null;

      // ── Deduplication: skip if an identical expense already exists ──────────
      // Match on same calendar day + amount + category + supplier to avoid
      // double-importing if the same CSV is uploaded more than once.
      const dayStart = new Date(date);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(date);
      dayEnd.setHours(23, 59, 59, 999);
      const duplicate = await this.prisma.forTenant().expense.findFirst({
        where: {
          deletedAt: null,
          date: { gte: dayStart, lte: dayEnd },
          amount,
          categoryId,
          ...(supplierId ? { supplierId } : { supplierId: null }),
        },
        select: { id: true },
      });
      if (duplicate) {
        skipped++;
        continue;
      }

      try {
        const expense = await this.prisma.forTenant().expense.create({
          data: {
            categoryId,
            importBatchId,
            amount,
            date,
            description,
            paymentMethod: "CASH",
            notes,
            referenceNumber,
            performedById: userId,
            ...(supplierId ? { supplierId } : {}),
          },
        });

        // If this is an inventory purchase, create a vendor bill so it appears
        // in the Inventory Purchases tab rather than the Other Expenses tab.
        if (inventoryCatIds.has(categoryId)) {
          try {
            const bill = await this.vendorBillsService.create({
              requireSupplier: false,
              supplierId: supplierId ?? undefined,
              totalOwed: amount,
              billDate: date.toISOString(),
              notes: description ?? undefined,
              items: [],
            });
            await this.prisma.forTenant().expense.update({
              where: { id: expense.id },
              data: { vendorBillId: bill.id },
            });
          } catch (billErr: any) {
            this.logger.warn(
              `Could not create vendor bill for imported expense ${expense.id}: ${billErr.message}`,
            );
          }
        }

        imported++;
      } catch (e: any) {
        errors.push(e.message);
        skipped++;
      }
    }
    return { imported, skipped, errors, suppliersCreated, suppliersUpdated, importBatchId };
  }

  // ── Import batch rollback ──────────────────────────────────────────────────

  /**
   * Soft-deletes all expenses that belong to a given import batch.
   * Safe to call multiple times — already-deleted records are ignored.
   */
  async rollbackExpenseBatch(batchId: string): Promise<{ rolledBack: number }> {
    const result = await this.prisma.forTenant().expense.updateMany({
      where: { importBatchId: batchId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return { rolledBack: result.count };
  }

  /**
   * Lists the 20 most recent expense import batches for the current tenant,
   * ordered newest first. Only counts expenses that have not been rolled back.
   */
  async listExpenseBatches() {
    const rows = await this.prisma.forTenant().expense.groupBy({
      by: ["importBatchId"],
      where: { importBatchId: { not: null }, deletedAt: null },
      _count: { id: true },
      _sum: { amount: true },
      _min: { date: true, createdAt: true },
      _max: { date: true },
      orderBy: { _min: { createdAt: "desc" } },
      take: 20,
    });
    return rows.map((r) => ({
      batchId: r.importBatchId,
      expenseCount: r._count.id,
      totalAmount: Number(r._sum.amount ?? 0),
      earliestExpenseDate: r._min.date,
      latestExpenseDate: r._max.date,
      importedAt: r._min.createdAt,
    }));
  }

  // ── Inventory purchase repair ─────────────────────────────────────────────

  /**
   * Retroactively create vendor bills for any INVENTORY_PURCHASE expenses that
   * were imported before this logic existed (i.e. vendorBillId is null).
   * Safe to call multiple times — already-converted expenses are skipped.
   */
  async repairInventoryPurchaseExpenses(): Promise<{ converted: number; skipped: number }> {
    const invCat = await this.prisma
      .forTenant()
      .expenseCategory.findFirst({ where: { code: "INVENTORY_PURCHASE" } });
    if (!invCat) return { converted: 0, skipped: 0 };

    const unconverted = await this.prisma.forTenant().expense.findMany({
      where: { categoryId: invCat.id, vendorBillId: null, deletedAt: null },
    });

    let converted = 0;
    let skipped = 0;
    for (const expense of unconverted) {
      try {
        const bill = await this.vendorBillsService.create({
          requireSupplier: false,
          supplierId: (expense as any).supplierId ?? undefined,
          totalOwed: Number(expense.amount),
          billDate: expense.date?.toISOString(),
          notes: expense.description ?? undefined,
          items: [],
        });
        await this.prisma.forTenant().expense.update({
          where: { id: expense.id },
          data: { vendorBillId: bill.id },
        });
        converted++;
      } catch (e: any) {
        this.logger.warn(`repairInventoryPurchaseExpenses: skipped ${expense.id}: ${e.message}`);
        skipped++;
      }
    }
    return { converted, skipped };
  }

  // ── Orphaned customer repair ────────────────────────────────────────────────

  /**
   * Diagnose: find customers that have a zohoContactId but belong to a
   * different (or null) tenant than the one currently making the request.
   * Returns their count so the caller can decide whether to adopt them.
   */
  async diagnoseOrphanedContacts(tenantId: string) {
    // this.prisma (unscoped base client — NOT forTenant()) sees across all tenants
    const orphans = await this.prisma.customer.findMany({
      where: {
        zohoContactId: { not: null },
        NOT: { tenantId },
      },
      select: { id: true, businessName: true, tenantId: true },
      take: 100,
    });
    return {
      orphanCount: orphans.length,
      tenantId,
      sample: orphans.slice(0, 5),
    };
  }

  /**
   * Repair: reassign all customers (and their User accounts) that have a
   * zohoContactId but belong to a null/wrong tenant, adopting them into
   * the current tenant.
   *
   * This is the fix for the case where contacts were imported under the wrong
   * tenant context (e.g. by a super-admin without active impersonation).
   */
  async adoptOrphanedContacts(tenantId: string): Promise<{ adopted: number }> {
    // this.prisma (unscoped) — sees across ALL tenants
    const orphans = await this.prisma.customer.findMany({
      where: {
        zohoContactId: { not: null },
        NOT: { tenantId },
      },
      select: { id: true, userId: true },
    });

    if (orphans.length === 0) return { adopted: 0 };

    const customerIds = orphans.map((o) => o.id);
    const userIds = orphans.map((o) => o.userId).filter((id): id is string => !!id);

    // Reassign Customer records (unscoped updateMany)
    await this.prisma.customer.updateMany({
      where: { id: { in: customerIds } },
      data: { tenantId },
    });

    // Reassign associated User records
    if (userIds.length > 0) {
      await this.prisma.user.updateMany({
        where: { id: { in: userIds } },
        data: { tenantId },
      });
    }

    // Reassign CustomerAddress records
    await this.prisma.customerAddress.updateMany({
      where: { customerId: { in: customerIds } },
      data: { tenantId },
    });

    return { adopted: orphans.length };
  }

  /**
   * Identify customers that have no orders and whose name matches a supplier
   * record — these are vendor/expense contacts that were accidentally imported
   * as customers. Mark them supplierOnly=true to hide from the Customers list.
   * Safe to call multiple times; already-marked records are skipped.
   */
  async markSupplierOnlyCustomers(): Promise<{ marked: number; alreadyMarked: number }> {
    // Find all suppliers for name-matching
    const suppliers = await this.prisma.forTenant().supplier.findMany({
      select: { id: true, name: true },
    });
    const supplierNames = new Set(suppliers.map((s) => s.name.toLowerCase().trim()));

    // Candidates: customers with no orders AND whose businessName matches a supplier
    const candidates = await this.prisma.forTenant().customer.findMany({
      where: { supplierOnly: false },
      select: {
        id: true,
        businessName: true,
        _count: { select: { orders: true } },
      },
    });

    const toMark = candidates.filter((c) => {
      if ((c._count as any).orders > 0) return false; // has orders → real customer
      const name = (c.businessName ?? "").toLowerCase().trim();
      return supplierNames.has(name);
    });

    if (toMark.length === 0) return { marked: 0, alreadyMarked: 0 };

    const ids = toMark.map((c) => c.id);
    await this.prisma.forTenant().customer.updateMany({
      where: { id: { in: ids } },
      data: { supplierOnly: true },
    });

    return { marked: toMark.length, alreadyMarked: 0 };
  }

  async importProducts(
    buffer: Buffer,
    userId: string,
  ): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const rows = this.parseCsv(buffer);
    let imported = 0,
      skipped = 0;
    const errors: string[] = [];

    for (const row of rows) {
      const name = (row["Item Name"] || row["Name"] || "").trim();
      if (!name) {
        skipped++;
        continue;
      }

      const pricePerUnit = parseFloat(row["Rate"] || row["Sales Rate"] || row["Price"] || "0") || 0;
      const description = row["Description"] || row["Item Description"] || null;
      const unit = (row["Unit"] || row["Usage Unit"] || "unit").trim() || "unit";
      const sku = row["SKU"] || null;

      try {
        // Skip if a product with this name already exists (case-insensitive)
        const existing = await this.prisma.forTenant().product.findFirst({
          where: { name: { equals: name, mode: "insensitive" } },
          select: { id: true },
        });
        if (existing) {
          skipped++;
          continue;
        }

        await this.prisma.forTenant().product.create({
          data: {
            name,
            description: description || null,
            pricePerUnit,
            unit,
            sku: sku || null,
            isActive: true,
          },
        });
        imported++;
      } catch (e: any) {
        errors.push(`${name}: ${e.message}`);
        skipped++;
      }
    }
    return { imported, skipped, errors };
  }

  /**
   * Import stock levels from Zoho Stock Summary Report CSV.
   * Columns: Item Name, SKU, Opening Stock, Quantity In, Quantity Out, Closing Stock
   *
   * For each row:
   *  - Find product by barcode (SKU) or name
   *  - Create product if not found (using Closing Stock as initial stock)
   *  - Update currentStock to Closing Stock value
   */
  async importInventory(
    buffer: Buffer,
    userId: string,
  ): Promise<{ updated: number; created: number; skipped: number; errors: string[] }> {
    const rows = this.parseCsv(buffer);
    let updated = 0,
      created = 0,
      skipped = 0;
    const errors: string[] = [];

    for (const row of rows) {
      const name = (row["Item Name"] || "").trim();
      if (!name) {
        skipped++;
        continue;
      }

      // Skip summary/header rows (e.g. "Purchase Invoice" with comma-formatted numbers)
      const rawSku = (row["SKU"] || "").trim();
      // If SKU contains commas it's a formatted number (not a real barcode) — skip
      if (rawSku.includes(",")) {
        skipped++;
        continue;
      }

      // Parse closing stock — handle comma-formatted values like "2,100.00"
      const closingStockRaw = (row["Closing Stock"] || "0").replace(/,/g, "");
      const closingStock = parseFloat(closingStockRaw);
      if (isNaN(closingStock)) {
        skipped++;
        continue;
      }

      // Detect summary rows: names like "Purchase Invoice" with no barcode and big stock numbers
      const lowerName = name.toLowerCase();
      if (
        !rawSku &&
        (lowerName.includes("invoice") ||
          lowerName.includes("purchase") ||
          lowerName.includes("account"))
      ) {
        skipped++;
        continue;
      }

      try {
        // Try to find existing product by barcode first, then by name
        let product = rawSku
          ? await this.prisma
              .forTenant()
              .product.findFirst({ where: { OR: [{ barcode: rawSku }, { sku: rawSku }] } })
          : null;

        if (!product) {
          product = await this.prisma.forTenant().product.findFirst({
            where: { name: { equals: name, mode: "insensitive" } },
          });
        }

        if (product) {
          // Update stock level
          await this.prisma.forTenant().product.update({
            where: { id: product.id },
            data: { currentStock: closingStock },
          });
          // Record the stock adjustment as a stock movement
          if (closingStock !== Number(product.currentStock)) {
            await this.prisma.forTenant().stockMovement.create({
              data: {
                productId: product.id,
                type: "ADJUSTMENT",
                quantity: closingStock - Number(product.currentStock),
                notes: "Zoho stock sync",
                performedById: userId,
              },
            });
          }
          updated++;
        } else {
          // Create new product with this stock level
          await this.prisma.forTenant().product.create({
            data: {
              name,
              barcode: rawSku || null,
              sku: rawSku || null,
              currentStock: closingStock,
              pricePerUnit: 0,
              unit: "unit",
              isActive: true,
            },
          });
          created++;
        }
      } catch (e: any) {
        errors.push(`${name}: ${e.message}`);
        skipped++;
      }
    }

    return { updated, created, skipped, errors };
  }

  /**
   * Reads unique supplier names from a Zoho Expense CSV ("Customer Name" column),
   * cross-references existing Customer records (incorrectly imported from Zoho),
   * creates/updates proper Supplier records with full info, then removes those
   * Customer records from the database.
   */
  async importExpenseSuppliers(buffer: Buffer): Promise<{
    created: number;
    updated: number;
    removedFromCustomers: number;
    skipped: number;
    errors: string[];
  }> {
    const rows = this.parseCsv(buffer);
    const errors: string[] = [];
    let created = 0,
      updated = 0,
      skipped = 0;
    const removedFromCustomers = 0;

    // Group rows by vendor name — checks Merchant Name / Vendor Name / Customer Name / etc.
    const vendorRowMap: Record<string, any> = {};
    for (const row of rows) {
      const n = this.getVendorName(row);
      if (n && !vendorRowMap[n.toLowerCase()]) vendorRowMap[n.toLowerCase()] = row;
    }

    const supplierNames = Object.keys(vendorRowMap).map((k) => this.getVendorName(vendorRowMap[k]));

    for (const name of supplierNames) {
      try {
        const sampleRow = vendorRowMap[name.toLowerCase()];

        // Build full supplier profile: CSV columns + customer contact match
        const supplierData = await this.buildSupplierData(name, sampleRow);

        // Upsert supplier (match by name case-insensitive)
        const existing = await this.prisma.forTenant().supplier.findFirst({
          where: { name: { equals: name, mode: "insensitive" } },
        });

        if (existing) {
          await this.prisma.forTenant().supplier.update({
            where: { id: existing.id },
            data: supplierData,
          });
          updated++;
        } else {
          await this.prisma.forTenant().supplier.create({ data: supplierData as any });
          created++;
        }
      } catch (e: any) {
        errors.push(`${name}: ${e.message}`);
        skipped++;
      }
    }

    return { created, updated, removedFromCustomers, skipped, errors };
  }
}
