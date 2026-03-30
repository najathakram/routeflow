import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parse } from 'csv-parse/sync';
import { InvoiceStatus, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(private readonly prisma: PrismaService) {}

  private parseCsv(buffer: Buffer): any[] {
    try {
      return parse(buffer.toString('utf8'), {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        relax_quotes: true,
        trim: true,
      });
    } catch (e) {
      this.logger.error('CSV parse error', e);
      return [];
    }
  }

  private generateTempPassword(): string {
    return crypto.randomBytes(6).toString('hex');
  }

  private mapPaymentMethod(method: string): string {
    const m = (method || '').toLowerCase().trim();
    if (m === 'cash') return 'CASH';
    if (m === 'check' || m === 'cheque') return 'CHECK';
    if (m === 'zelle' || m === 'ach' || m === 'wire') return 'ACH';
    return 'OTHER';
  }

  private mapInvoiceStatus(zohoStatus: string): InvoiceStatus {
    const s = (zohoStatus || '').toLowerCase().trim();
    if (s === 'closed' || s === 'paid') return InvoiceStatus.PAID;
    if (s === 'overdue') return InvoiceStatus.OVERDUE;
    if (s === 'draft') return InvoiceStatus.DRAFT;
    if (s.includes('partial')) return InvoiceStatus.PARTIAL;
    if (s === 'void' || s === 'voided') return InvoiceStatus.VOID;
    return InvoiceStatus.SENT;
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 30);
  }

  async importContacts(buffer: Buffer, userId: string): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const rows = this.parseCsv(buffer);
    let imported = 0, skipped = 0;
    const errors: string[] = [];

    for (const row of rows) {
      const name = (row['Customer Name'] || row['Display Name'] || row['Company Name'] || '').trim();
      if (!name) { skipped++; continue; }

      const street = [row['Billing Address'], row['Billing Street2']].filter(Boolean).join(', ').trim();
      const city = (row['Billing City'] || '').trim();
      const state = (row['Billing State'] || '').trim();
      const zip = (row['Billing Code'] || '').trim();
      const phone = (row['Billing Phone'] || row['MobilePhone'] || row['Phone'] || '').replace(/['+]/g, '').trim();
      const email = (row['EmailID'] || row['Email'] || '').trim();
      const contactName = [row['First Name'], row['Last Name']].filter(Boolean).join(' ').trim() || row['Billing Attention'] || name;

      // Generate a unique username from business name
      const baseUsername = this.slugify(name);
      let username = baseUsername;
      let suffix = 1;
      while (await this.prisma.user.findFirst({ where: { username } })) {
        username = `${baseUsername}_${suffix++}`;
      }

      // Generate a unique email if none provided
      const userEmail = email || `${username}@imported.local`;

      // Check if user/customer already exists
      const existingUser = await this.prisma.user.findFirst({
        where: { OR: [{ email: userEmail }, { username }] },
      });
      if (existingUser) {
        skipped++;
        errors.push(`${name}: username or email already exists`);
        continue;
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
              phone: phone || null,
              notes: null,
            },
          });

          // Create a default address if we have address data
          if (street || city || state || zip) {
            await tx.customerAddress.create({
              data: {
                customerId: customer.id,
                label: 'default',
                line1: street || city || 'Unknown',
                city: city || 'Unknown',
                state: state || 'TX',
                zip: zip || '00000',
                isDefault: true,
              },
            });
          }
        });

        imported++;
      } catch (e: any) {
        errors.push(`${name}: ${e.message}`);
        skipped++;
      }
    }
    return { imported, skipped, errors };
  }

  async importInvoices(buffer: Buffer, userId: string): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const rows = this.parseCsv(buffer);
    let imported = 0, skipped = 0;
    const errors: string[] = [];

    // Group by Invoice ID
    const groups: Record<string, any[]> = {};
    for (const row of rows) {
      const id = row['Invoice ID'] || row['Invoice Number'];
      if (!id) continue;
      if (!groups[id]) groups[id] = [];
      groups[id].push(row);
    }

    const year = new Date().getFullYear();
    let seq = 1;

    for (const [, invoiceRows] of Object.entries(groups)) {
      const first = invoiceRows[0];
      const customerName = (first['Customer Name'] || first['Company Name'] || '').trim();
      if (!customerName) { skipped++; continue; }

      // Try to find existing customer
      let customer = await this.prisma.customer.findFirst({
        where: { businessName: { contains: customerName, mode: 'insensitive' } },
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
        const existingUser = await this.prisma.user.findFirst({ where: { OR: [{ email: userEmail }, { username }] } });
        if (existingUser) {
          skipped++;
          errors.push(`${customerName}: user conflict, skipped`);
          continue;
        }
        try {
          const hashedPassword = await bcrypt.hash(this.generateTempPassword(), 10);
          const street = (first['Billing Address'] || first['Billing Street'] || '').trim();
          const city = (first['Billing City'] || '').trim();
          const state = (first['Billing State'] || '').trim();
          const zip = (first['Billing Code'] || '').trim();
          const phone = (first['Billing Phone'] || '').replace(/['+]/g, '').trim();

          await this.prisma.$transaction(async (tx) => {
            const user = await tx.user.create({
              data: { email: userEmail, username, password: hashedPassword, role: UserRole.CUSTOMER, forcePasswordChange: true },
            });
            customer = await tx.customer.create({
              data: { userId: user.id, businessName: customerName, contactName: customerName, phone: phone || null },
            });
            if (street || city) {
              await tx.customerAddress.create({
                data: { customerId: customer!.id, label: 'default', line1: street || city || 'Unknown', city: city || 'Unknown', state: state || 'Unknown', zip: zip || '00000', isDefault: true },
              });
            }
          });
        } catch (e: any) {
          skipped++;
          errors.push(`${customerName}: ${e.message}`);
          continue;
        }
      }

      if (!customer) { skipped++; continue; }

      const total = parseFloat(first['Total'] || '0') || 0;
      const subtotal = parseFloat(first['SubTotal'] || '0') || total;
      const discount = parseFloat(first['Entity Discount Amount'] || '0') || 0;
      const shippingFee = parseFloat(first['Shipping Charge'] || '0') || 0;
      const status = this.mapInvoiceStatus(first['Invoice Status']);
      const invoiceNumber = first['Invoice Number'] || `INV-${year}-${String(seq++).padStart(4, '0')}`;
      const notes = first['Notes'] || null;
      const terms = first['Terms & Conditions'] || null;

      let issueDate = new Date();
      let dueDate: Date | null = null;
      try { if (first['Invoice Date']) issueDate = new Date(first['Invoice Date']); } catch {}
      try { if (first['Due Date']) dueDate = new Date(first['Due Date']); } catch {}

      // Build line items; try to match product by SKU
      const itemsData: any[] = [];
      for (const row of invoiceRows) {
        const description = (row['Item Name'] || '').replace(/[\n\r]+/g, ' ').trim() || 'Item';
        const qty = parseFloat(row['Quantity'] || '1') || 1;
        if (qty <= 0) continue;
        const unitPrice = parseFloat(row['Item Price'] || '0') || 0;
        const itemDiscount = parseFloat(row['Discount Amount'] || '0') || 0;
        const sub = parseFloat(row['Item Total'] || '0') || qty * unitPrice - itemDiscount;
        const sku = (row['SKU'] || '').trim();

        let productId: string | undefined;
        if (sku) {
          const product = await this.prisma.product.findFirst({ where: { sku: { equals: sku, mode: 'insensitive' } } });
          if (product) productId = product.id;
        }
        if (!productId && description && description !== 'Item') {
          const product = await this.prisma.product.findFirst({ where: { name: { equals: description, mode: 'insensitive' } } });
          if (product) productId = product.id;
        }

        itemsData.push({ description, qty, unitPrice, discount: itemDiscount, taxRate: 0, subtotal: sub, ...(productId ? { productId } : {}) });
      }

      if (itemsData.length === 0) {
        itemsData.push({ description: 'Services', qty: 1, unitPrice: total, discount: 0, taxRate: 0, subtotal: total });
      }

      try {
        // Skip if invoice number already exists
        const existing = await this.prisma.invoice.findFirst({ where: { invoiceNumber } });
        if (existing) { skipped++; errors.push(`${invoiceNumber}: already imported`); continue; }

        await this.prisma.invoice.create({
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
            paidAt: status === InvoiceStatus.PAID ? (dueDate || issueDate) : null,
            notes,
            terms,
            items: { create: itemsData },
          },
        });
        imported++;
      } catch (e: any) {
        errors.push(`${invoiceNumber}: ${e.message}`);
        skipped++;
      }
    }
    return { imported, skipped, errors };
  }

  async importPayments(buffer: Buffer, userId: string): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const rows = this.parseCsv(buffer);
    let imported = 0, skipped = 0;
    const errors: string[] = [];

    for (const row of rows) {
      const invoiceNumber = row['Invoice Number'];
      if (!invoiceNumber) { skipped++; continue; }

      const invoice = await this.prisma.invoice.findFirst({ where: { invoiceNumber } });
      if (!invoice) { skipped++; continue; }

      const amount = parseFloat(row['Amount Applied to Invoice'] || row['Amount'] || '0');
      if (amount <= 0) { skipped++; continue; }

      const method = this.mapPaymentMethod(row['Mode']) as any;
      const reference = row['Reference Number'] || null;
      let createdAt = new Date();
      try { if (row['Date']) createdAt = new Date(row['Date']); } catch (e) {}

      try {
        await this.prisma.invoicePayment.create({
          data: { invoiceId: invoice.id, amount, method, reference, createdAt },
        });
        imported++;
      } catch (e: any) {
        errors.push(`Payment for ${invoiceNumber}: ${e.message}`);
        skipped++;
      }
    }

    // Update invoice statuses based on total payments
    const allInvoices = await this.prisma.invoice.findMany({ include: { payments: true } });
    for (const inv of allInvoices) {
      const totalPaid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
      const total = Number(inv.total);
      let newStatus: InvoiceStatus;
      const now = new Date();
      if (totalPaid >= total - 0.01) newStatus = InvoiceStatus.PAID;
      else if (totalPaid > 0) newStatus = InvoiceStatus.PARTIAL;
      else if (inv.dueDate && inv.dueDate < now) newStatus = InvoiceStatus.OVERDUE;
      else newStatus = inv.status;
      if (newStatus !== inv.status) {
        await this.prisma.invoice.update({
          where: { id: inv.id },
          data: { status: newStatus, paidAt: newStatus === InvoiceStatus.PAID ? now : null },
        });
      }
    }

    return { imported, skipped, errors };
  }

  async importExpenses(buffer: Buffer, userId: string): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const rows = this.parseCsv(buffer);
    let imported = 0, skipped = 0;
    const errors: string[] = [];

    // Ensure expense categories exist
    const catMap: Record<string, string> = {};
    const catNames = [...new Set(rows.map((r: any) => r['Expense Category']).filter(Boolean))] as string[];
    for (const catName of catNames) {
      const code = catName.toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 20);
      let cat = await this.prisma.expenseCategory.findFirst({ where: { name: catName } });
      if (!cat) {
        try {
          cat = await this.prisma.expenseCategory.create({ data: { name: catName, code, isCustom: true } });
        } catch {
          try {
            cat = await this.prisma.expenseCategory.create({ data: { name: catName, code: code + '_Z', isCustom: true } });
          } catch {}
        }
      }
      if (cat) catMap[catName] = cat.id;
    }

    for (const row of rows) {
      const catName = row['Expense Category'];
      const categoryId = catMap[catName];
      if (!categoryId) { skipped++; continue; }

      const amount = parseFloat(row['Total'] || row['Expense Amount'] || '0');
      if (amount <= 0) { skipped++; continue; }

      let date = new Date();
      try { if (row['Expense Date']) date = new Date(row['Expense Date']); } catch (e) {}

      const description = row['Expense Description'] || row['Reference#'] || null;
      const notes = row['Reference#'] || null;

      try {
        await this.prisma.expense.create({
          data: {
            categoryId,
            amount,
            date,
            description,
            paymentMethod: 'CASH',
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

  async importProducts(buffer: Buffer, userId: string): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const rows = this.parseCsv(buffer);
    let imported = 0, skipped = 0;
    const errors: string[] = [];

    for (const row of rows) {
      const name = (row['Item Name'] || row['Name'] || '').trim();
      if (!name) { skipped++; continue; }

      const pricePerUnit = parseFloat(row['Rate'] || row['Sales Rate'] || row['Price'] || '0') || 0;
      const description = row['Description'] || row['Item Description'] || null;
      const unit = (row['Unit'] || row['Usage Unit'] || 'unit').trim() || 'unit';
      const sku = row['SKU'] || null;

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
}
