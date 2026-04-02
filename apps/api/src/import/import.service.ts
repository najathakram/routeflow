import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { parse } from "csv-parse/sync";
import { InvoiceStatus, UserRole } from "@prisma/client";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(private readonly prisma: PrismaService) {}

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
    if (s === "write off" || s === "write-off" || s === "written off" || s === "written-off") return InvoiceStatus.WRITTEN_OFF;
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
      const phone = (row["Phone"] || row["Billing Phone"] || "")
        .replace(/^'+/, "").replace(/'+/g, "").trim() || null;
      // Mobile from MobilePhone column
      const mobile = (row["MobilePhone"] || "")
        .replace(/^'+/, "").replace(/'+/g, "").trim() || null;
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
        .filter(Boolean).join(", ").trim();
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
        .filter(Boolean).join(", ").trim();
      const shippingCity = (row["Shipping City"] || "").trim();
      const shippingState = (row["Shipping State"] || "").trim();
      const shippingZip = (row["Shipping Code"] || "").trim();
      const shippingLatRaw = parseFloat(row["Shipping Latitude"] || "");
      const shippingLngRaw = parseFloat(row["Shipping Longitude"] || "");
      const shippingLat = isNaN(shippingLatRaw) ? null : shippingLatRaw;
      const shippingLng = isNaN(shippingLngRaw) ? null : shippingLngRaw;
      // Only create shipping if it has data and differs from billing
      const hasShipping = !!(shippingLine1 || shippingCity) &&
        (shippingLine1 !== billingLine1 || shippingCity !== billingCity || shippingZip !== billingZip);

      // Check if this customer was already imported (by Zoho ID)
      if (zohoContactId) {
        const existing = await this.prisma.customer.findFirst({
          where: { zohoContactId },
          include: { addresses: true, contactPersons: true },
        });
        if (existing) {
          // Update the existing customer with any missing/new fields
          try {
            await this.prisma.customer.update({
              where: { id: existing.id },
              data: {
                ...(displayName !== null && { displayName }),
                ...(salutation !== null && { salutation }),
                ...(firstName !== null && { firstName }),
                ...(lastName !== null && { lastName }),
                ...(phone !== null && !existing.phone && { phone }),
                ...(mobile !== null && { mobile }),
                ...(csvEmail !== null && { email: csvEmail }),
                ...(notes !== null && { notes }),
                currency,
                contactName: existing.contactName === existing.businessName ? (contactName || existing.contactName) : existing.contactName,
              },
            });

            // Add billing address if not already present
            const existingBilling = existing.addresses.find(a => a.addressType === "BILLING");
            if (!existingBilling && hasBilling) {
              await this.prisma.customerAddress.create({
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
            const existingShipping = existing.addresses.find(a => a.addressType === "SHIPPING");
            if (!existingShipping && hasShipping) {
              await this.prisma.customerAddress.create({
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
              await this.prisma.contactPerson.create({
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
      }

      // Generate a unique username from business name
      const baseUsername = this.slugify(name);
      let username = baseUsername;
      let suffix = 1;
      while (await this.prisma.user.findFirst({ where: { username } })) {
        username = `${baseUsername}_${suffix++}`;
      }

      // Determine user email: use CSV email if not taken, otherwise synthetic
      let userEmail: string;
      if (csvEmail) {
        const emailTaken = await this.prisma.user.findFirst({ where: { email: csvEmail } });
        userEmail = emailTaken ? `${username}@imported.local` : csvEmail;
      } else {
        userEmail = `${username}@imported.local`;
      }

      try {
        const hashedPassword = await bcrypt.hash(this.generateTempPassword(), 10);

        await this.prisma.$transaction(async (tx) => {
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
        errors.push(`${name}: ${e.message}`);
        skipped++;
      }
    }
    return { created, updated, skipped, errors };
  }

  async importInvoices(
    buffer: Buffer,
    userId: string,
  ): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const rows = this.parseCsv(buffer);
    let imported = 0,
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
      let customer = await this.prisma.customer.findFirst({
        where: { businessName: { contains: customerName, mode: "insensitive" } },
      });

      // Auto-create customer if not found
      if (!customer) {
        const baseUsername = this.slugify(customerName);
        let username = baseUsername;
        let usernameSeq = 1;
        while (await this.prisma.user.findFirst({ where: { username } })) {
          username = `${baseUsername}_${usernameSeq++}`;
        }
        const userEmail = `${username}@imported.local`;
        const existingUser = await this.prisma.user.findFirst({
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

          await this.prisma.$transaction(async (tx) => {
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
      const discount = parseFloat(first["Entity Discount Amount"] || first["Discount Amount"] || "0") || 0;
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
      } catch (_e) { /* ignore */ }
      try {
        if (first["Due Date"]) dueDate = new Date(first["Due Date"]);
      } catch (_e) { /* ignore */ }
      try {
        const pd = first["Payment Date"] || first["Last Payment Date"];
        if (pd) paidDate = new Date(pd);
      } catch (_e) { /* ignore */ }

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

      const paidAt =
        status === InvoiceStatus.PAID
          ? (paidDate || dueDate || issueDate)
          : null;

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
          const product = await this.prisma.product.findFirst({
            where: { sku: { equals: sku, mode: "insensitive" } },
          });
          if (product) productId = product.id;
        }
        if (!productId && description && description !== "Item") {
          const product = await this.prisma.product.findFirst({
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
        // Skip if invoice number already exists
        const existing = await this.prisma.invoice.findFirst({ where: { invoiceNumber } });
        if (existing) {
          skipped++;
          errors.push(`${invoiceNumber}: already imported`);
          continue;
        }

        const newInvoice = await this.prisma.invoice.create({
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
            await this.prisma.invoicePayment.create({
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
    return { imported, skipped, errors };
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

      const invoice = await this.prisma.invoice.findFirst({ where: { invoiceNumber } });
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
          const dup = await this.prisma.invoicePayment.findFirst({
            where: { invoiceId: invoice.id, reference: zohoPaymentId },
          });
          if (dup) { skipped++; continue; }
        }

        // Also remove any synthetic "zoho-import" placeholder payment for this invoice
        // now that we have the real payment record
        await this.prisma.invoicePayment.deleteMany({
          where: { invoiceId: invoice.id, reference: "zoho-import" },
        });

        await this.prisma.invoicePayment.create({
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

    // Update invoice statuses based on total payments — wrapped in a single transaction
    const allInvoices = await this.prisma.invoice.findMany({ include: { payments: true } });
    const now = new Date();
    const statusUpdates: Array<{ id: string; status: InvoiceStatus; paidAt: Date | null }> = [];
    for (const inv of allInvoices) {
      const totalPaid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
      const total = Number(inv.total);
      let newStatus: InvoiceStatus;
      if (totalPaid >= total - 0.01) newStatus = InvoiceStatus.PAID;
      else if (totalPaid > 0) newStatus = InvoiceStatus.PARTIAL;
      else if (inv.dueDate && inv.dueDate < now) newStatus = InvoiceStatus.OVERDUE;
      else newStatus = inv.status;
      if (newStatus !== inv.status) {
        statusUpdates.push({ id: inv.id, status: newStatus, paidAt: newStatus === InvoiceStatus.PAID ? now : null });
      }
    }
    if (statusUpdates.length > 0) {
      await this.prisma.$transaction(
        statusUpdates.map((u) =>
          this.prisma.invoice.update({
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
  ): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const rows = this.parseCsv(buffer);
    let imported = 0,
      skipped = 0;
    const errors: string[] = [];

    // Ensure expense categories exist
    const catMap: Record<string, string> = {};
    const catNames = [
      ...new Set(rows.map((r: any) => r["Expense Category"]).filter(Boolean)),
    ] as string[];
    for (const catName of catNames) {
      const code = catName
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "_")
        .slice(0, 20);
      let cat = await this.prisma.expenseCategory.findFirst({ where: { name: catName } });
      if (!cat) {
        try {
          cat = await this.prisma.expenseCategory.create({
            data: { name: catName, code, isCustom: true },
          });
        } catch {
          try {
            cat = await this.prisma.expenseCategory.create({
              data: { name: catName, code: code + "_Z", isCustom: true },
            });
          } catch (_e) {
            /* ignore */
          }
        }
      }
      if (cat) catMap[catName] = cat.id;
    }

    for (const row of rows) {
      const catName = row["Expense Category"];
      const categoryId = catMap[catName];
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

      const description = row["Expense Description"] || row["Reference#"] || null;
      const notes = row["Reference#"] || null;

      try {
        await this.prisma.expense.create({
          data: {
            categoryId,
            amount,
            date,
            description,
            paymentMethod: "CASH",
            notes,
            performedById: userId,
          },
        });
        imported++;
      } catch (e: any) {
        errors.push(e.message);
        skipped++;
      }
    }
    return { imported, skipped, errors };
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
        await this.prisma.product.create({
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
    let updated = 0, created = 0, skipped = 0;
    const errors: string[] = [];

    for (const row of rows) {
      const name = (row["Item Name"] || "").trim();
      if (!name) { skipped++; continue; }

      // Skip summary/header rows (e.g. "Purchase Invoice" with comma-formatted numbers)
      const rawSku = (row["SKU"] || "").trim();
      // If SKU contains commas it's a formatted number (not a real barcode) — skip
      if (rawSku.includes(",")) { skipped++; continue; }

      // Parse closing stock — handle comma-formatted values like "2,100.00"
      const closingStockRaw = (row["Closing Stock"] || "0").replace(/,/g, "");
      const closingStock = parseFloat(closingStockRaw);
      if (isNaN(closingStock)) { skipped++; continue; }

      // Detect summary rows: names like "Purchase Invoice" with no barcode and big stock numbers
      const lowerName = name.toLowerCase();
      if (!rawSku && (lowerName.includes("invoice") || lowerName.includes("purchase") || lowerName.includes("account"))) {
        skipped++;
        continue;
      }

      try {
        // Try to find existing product by barcode first, then by name
        let product = rawSku
          ? await this.prisma.product.findFirst({ where: { OR: [{ barcode: rawSku }, { sku: rawSku }] } })
          : null;

        if (!product) {
          product = await this.prisma.product.findFirst({
            where: { name: { equals: name, mode: "insensitive" } },
          });
        }

        if (product) {
          // Update stock level
          await this.prisma.product.update({
            where: { id: product.id },
            data: { currentStock: closingStock },
          });
          // Record the stock adjustment as a stock movement
          if (closingStock !== Number(product.currentStock)) {
            await this.prisma.stockMovement.create({
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
          await this.prisma.product.create({
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
    let created = 0, updated = 0, removedFromCustomers = 0, skipped = 0;

    // Collect unique, non-empty supplier names from "Customer Name" column
    const supplierNames = [
      ...new Set(
        rows
          .map((r: any) => (r["Customer Name"] || "").trim())
          .filter(Boolean),
      ),
    ] as string[];

    for (const name of supplierNames) {
      try {
        // Find matching customer records (businessName or displayName match)
        const matchingCustomers = await this.prisma.customer.findMany({
          where: {
            OR: [
              { businessName: { equals: name, mode: "insensitive" } },
              { displayName: { equals: name, mode: "insensitive" } },
            ],
          },
          include: { addresses: true },
        });

        // Build supplier data from the first matched customer (if any)
        const supplierData: any = { name };
        if (matchingCustomers.length > 0) {
          const c = matchingCustomers[0];
          if (c.phone) supplierData.phone = c.phone;
          if (c.mobile) supplierData.mobile = c.mobile;
          if (c.email) supplierData.email = c.email;
          if (c.notes) supplierData.notes = c.notes;

          // Use billing address first, then any address
          const billingAddr =
            c.addresses.find((a) => a.addressType === "BILLING") ??
            c.addresses[0];
          if (billingAddr) {
            supplierData.addressLine1 = billingAddr.line1 ?? undefined;
            supplierData.addressLine2 = billingAddr.line2 ?? undefined;
            supplierData.city = billingAddr.city ?? undefined;
            supplierData.state = billingAddr.state ?? undefined;
            supplierData.zip = billingAddr.zip ?? undefined;
          }
        }

        // Upsert supplier (match by name case-insensitive)
        const existing = await this.prisma.supplier.findFirst({
          where: { name: { equals: name, mode: "insensitive" } },
        });

        if (existing) {
          await this.prisma.supplier.update({
            where: { id: existing.id },
            data: supplierData,
          });
          updated++;
        } else {
          await this.prisma.supplier.create({ data: supplierData });
          created++;
        }

        // Delete all matched customer records (they were incorrectly added as customers)
        for (const customer of matchingCustomers) {
          try {
            // Delete non-cascade dependent records first
            await this.prisma.routeCustomer.deleteMany({ where: { customerId: customer.id } });
            await this.prisma.customerAddress.deleteMany({ where: { customerId: customer.id } });
            await this.prisma.customerTagAssignment.deleteMany({ where: { customerId: customer.id } });
            await this.prisma.contactPerson.deleteMany({ where: { customerId: customer.id } });
            await this.prisma.customerComment.deleteMany({ where: { customerId: customer.id } });
            await this.prisma.customer.delete({ where: { id: customer.id } });
            removedFromCustomers++;
          } catch (delErr: any) {
            errors.push(`Could not remove customer ${customer.displayName}: ${delErr.message}`);
          }
        }
      } catch (e: any) {
        errors.push(`${name}: ${e.message}`);
        skipped++;
      }
    }

    return { created, updated, removedFromCustomers, skipped, errors };
  }
}
