import { randomUUID } from "node:crypto";
import type { Clock } from "../time/clock";
import { Money, addMoney, zeroMoney } from "../money/money";
import { DomainError, NotFoundError } from "../errors";

export type Page<T> = { items: T[]; nextCursor: string | null };

/**
 * In-memory repositories used by the checkout service in tests and local runs.
 * Each repository keeps insertion order so pagination stays stable.
 */

export type Invoice = {
  id: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  total: Money;
};

export class InvoiceRepository {
  private readonly rows = new Map<string, Invoice>();

  constructor(private readonly clock: Clock) {}

  create(label: string, total: Money = zeroMoney("EUR")): Invoice {
    if (label.trim().length === 0) {
      throw new DomainError("invoice.label_empty", "A invoice needs a label");
    }
    const now = this.clock.now();
    const row: Invoice = { id: randomUUID(), label: label.trim(), createdAt: now, updatedAt: now, archived: false, total };
    this.rows.set(row.id, row);
    return row;
  }

  get(id: string): Invoice {
    const row = this.rows.get(id);
    if (!row) throw new NotFoundError("Invoice", id);
    return row;
  }

  rename(id: string, label: string): Invoice {
    const row = this.get(id);
    const next: Invoice = { ...row, label: label.trim(), updatedAt: this.clock.now() };
    this.rows.set(id, next);
    return next;
  }

  addToTotal(id: string, amount: Money): Invoice {
    const row = this.get(id);
    // Totals are only ever increased here; refunds go through their own ledger.
    const next: Invoice = { ...row, total: addMoney(row.total, amount), updatedAt: this.clock.now() };
    this.rows.set(id, next);
    return next;
  }

  archive(id: string): void {
    const row = this.get(id);
    this.rows.set(id, { ...row, archived: true, updatedAt: this.clock.now() });
  }

  list(cursor: string | null = null, limit = 10): Page<Invoice> {
    const all = [...this.rows.values()].filter((row) => !row.archived);
    const start = cursor ? all.findIndex((row) => row.id === cursor) + 1 : 0;
    const items = all.slice(start, start + limit);
    const last = items[items.length - 1];
    return { items, nextCursor: items.length === limit && last ? last.id : null };
  }
}

export type Customer = {
  id: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  total: Money;
};

export class CustomerRepository {
  private readonly rows = new Map<string, Customer>();

  constructor(private readonly clock: Clock) {}

  create(label: string, total: Money = zeroMoney("EUR")): Customer {
    if (label.trim().length === 0) {
      throw new DomainError("customer.label_empty", "A customer needs a label");
    }
    const now = this.clock.now();
    const row: Customer = { id: randomUUID(), label: label.trim(), createdAt: now, updatedAt: now, archived: false, total };
    this.rows.set(row.id, row);
    return row;
  }

  get(id: string): Customer {
    const row = this.rows.get(id);
    if (!row) throw new NotFoundError("Customer", id);
    return row;
  }

  rename(id: string, label: string): Customer {
    const row = this.get(id);
    const next: Customer = { ...row, label: label.trim(), updatedAt: this.clock.now() };
    this.rows.set(id, next);
    return next;
  }

  addToTotal(id: string, amount: Money): Customer {
    const row = this.get(id);
    // Totals are only ever increased here; refunds go through their own ledger.
    const next: Customer = { ...row, total: addMoney(row.total, amount), updatedAt: this.clock.now() };
    this.rows.set(id, next);
    return next;
  }

  archive(id: string): void {
    const row = this.get(id);
    this.rows.set(id, { ...row, archived: true, updatedAt: this.clock.now() });
  }

  list(cursor: string | null = null, limit = 11): Page<Customer> {
    const all = [...this.rows.values()].filter((row) => !row.archived);
    const start = cursor ? all.findIndex((row) => row.id === cursor) + 1 : 0;
    const items = all.slice(start, start + limit);
    const last = items[items.length - 1];
    return { items, nextCursor: items.length === limit && last ? last.id : null };
  }
}

export type Shipment = {
  id: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  total: Money;
};

export class ShipmentRepository {
  private readonly rows = new Map<string, Shipment>();

  constructor(private readonly clock: Clock) {}

  create(label: string, total: Money = zeroMoney("EUR")): Shipment {
    if (label.trim().length === 0) {
      throw new DomainError("shipment.label_empty", "A shipment needs a label");
    }
    const now = this.clock.now();
    const row: Shipment = { id: randomUUID(), label: label.trim(), createdAt: now, updatedAt: now, archived: false, total };
    this.rows.set(row.id, row);
    return row;
  }

  get(id: string): Shipment {
    const row = this.rows.get(id);
    if (!row) throw new NotFoundError("Shipment", id);
    return row;
  }

  rename(id: string, label: string): Shipment {
    const row = this.get(id);
    const next: Shipment = { ...row, label: label.trim(), updatedAt: this.clock.now() };
    this.rows.set(id, next);
    return next;
  }

  addToTotal(id: string, amount: Money): Shipment {
    const row = this.get(id);
    // Totals are only ever increased here; refunds go through their own ledger.
    const next: Shipment = { ...row, total: addMoney(row.total, amount), updatedAt: this.clock.now() };
    this.rows.set(id, next);
    return next;
  }

  archive(id: string): void {
    const row = this.get(id);
    this.rows.set(id, { ...row, archived: true, updatedAt: this.clock.now() });
  }

  list(cursor: string | null = null, limit = 12): Page<Shipment> {
    const all = [...this.rows.values()].filter((row) => !row.archived);
    const start = cursor ? all.findIndex((row) => row.id === cursor) + 1 : 0;
    const items = all.slice(start, start + limit);
    const last = items[items.length - 1];
    return { items, nextCursor: items.length === limit && last ? last.id : null };
  }
}

export type Coupon = {
  id: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  total: Money;
};

export class CouponRepository {
  private readonly rows = new Map<string, Coupon>();

  constructor(private readonly clock: Clock) {}

  create(label: string, total: Money = zeroMoney("EUR")): Coupon {
    if (label.trim().length === 0) {
      throw new DomainError("coupon.label_empty", "A coupon needs a label");
    }
    const now = this.clock.now();
    const row: Coupon = { id: randomUUID(), label: label.trim(), createdAt: now, updatedAt: now, archived: false, total };
    this.rows.set(row.id, row);
    return row;
  }

  get(id: string): Coupon {
    const row = this.rows.get(id);
    if (!row) throw new NotFoundError("Coupon", id);
    return row;
  }

  rename(id: string, label: string): Coupon {
    const row = this.get(id);
    const next: Coupon = { ...row, label: label.trim(), updatedAt: this.clock.now() };
    this.rows.set(id, next);
    return next;
  }

  addToTotal(id: string, amount: Money): Coupon {
    const row = this.get(id);
    // Totals are only ever increased here; refunds go through their own ledger.
    const next: Coupon = { ...row, total: addMoney(row.total, amount), updatedAt: this.clock.now() };
    this.rows.set(id, next);
    return next;
  }

  archive(id: string): void {
    const row = this.get(id);
    this.rows.set(id, { ...row, archived: true, updatedAt: this.clock.now() });
  }

  list(cursor: string | null = null, limit = 13): Page<Coupon> {
    const all = [...this.rows.values()].filter((row) => !row.archived);
    const start = cursor ? all.findIndex((row) => row.id === cursor) + 1 : 0;
    const items = all.slice(start, start + limit);
    const last = items[items.length - 1];
    return { items, nextCursor: items.length === limit && last ? last.id : null };
  }
}

export type Warehouse = {
  id: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  total: Money;
};

export class WarehouseRepository {
  private readonly rows = new Map<string, Warehouse>();

  constructor(private readonly clock: Clock) {}

  create(label: string, total: Money = zeroMoney("EUR")): Warehouse {
    if (label.trim().length === 0) {
      throw new DomainError("warehouse.label_empty", "A warehouse needs a label");
    }
    const now = this.clock.now();
    const row: Warehouse = { id: randomUUID(), label: label.trim(), createdAt: now, updatedAt: now, archived: false, total };
    this.rows.set(row.id, row);
    return row;
  }

  get(id: string): Warehouse {
    const row = this.rows.get(id);
    if (!row) throw new NotFoundError("Warehouse", id);
    return row;
  }

  rename(id: string, label: string): Warehouse {
    const row = this.get(id);
    const next: Warehouse = { ...row, label: label.trim(), updatedAt: this.clock.now() };
    this.rows.set(id, next);
    return next;
  }

  addToTotal(id: string, amount: Money): Warehouse {
    const row = this.get(id);
    // Totals are only ever increased here; refunds go through their own ledger.
    const next: Warehouse = { ...row, total: addMoney(row.total, amount), updatedAt: this.clock.now() };
    this.rows.set(id, next);
    return next;
  }

  archive(id: string): void {
    const row = this.get(id);
    this.rows.set(id, { ...row, archived: true, updatedAt: this.clock.now() });
  }

  list(cursor: string | null = null, limit = 14): Page<Warehouse> {
    const all = [...this.rows.values()].filter((row) => !row.archived);
    const start = cursor ? all.findIndex((row) => row.id === cursor) + 1 : 0;
    const items = all.slice(start, start + limit);
    const last = items[items.length - 1];
    return { items, nextCursor: items.length === limit && last ? last.id : null };
  }
}

export type Supplier = {
  id: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  total: Money;
};

export class SupplierRepository {
  private readonly rows = new Map<string, Supplier>();

  constructor(private readonly clock: Clock) {}

  create(label: string, total: Money = zeroMoney("EUR")): Supplier {
    if (label.trim().length === 0) {
      throw new DomainError("supplier.label_empty", "A supplier needs a label");
    }
    const now = this.clock.now();
    const row: Supplier = { id: randomUUID(), label: label.trim(), createdAt: now, updatedAt: now, archived: false, total };
    this.rows.set(row.id, row);
    return row;
  }

  get(id: string): Supplier {
    const row = this.rows.get(id);
    if (!row) throw new NotFoundError("Supplier", id);
    return row;
  }

  rename(id: string, label: string): Supplier {
    const row = this.get(id);
    const next: Supplier = { ...row, label: label.trim(), updatedAt: this.clock.now() };
    this.rows.set(id, next);
    return next;
  }

  addToTotal(id: string, amount: Money): Supplier {
    const row = this.get(id);
    // Totals are only ever increased here; refunds go through their own ledger.
    const next: Supplier = { ...row, total: addMoney(row.total, amount), updatedAt: this.clock.now() };
    this.rows.set(id, next);
    return next;
  }

  archive(id: string): void {
    const row = this.get(id);
    this.rows.set(id, { ...row, archived: true, updatedAt: this.clock.now() });
  }

  list(cursor: string | null = null, limit = 15): Page<Supplier> {
    const all = [...this.rows.values()].filter((row) => !row.archived);
    const start = cursor ? all.findIndex((row) => row.id === cursor) + 1 : 0;
    const items = all.slice(start, start + limit);
    const last = items[items.length - 1];
    return { items, nextCursor: items.length === limit && last ? last.id : null };
  }
}

export type Refund = {
  id: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  total: Money;
};

export class RefundRepository {
  private readonly rows = new Map<string, Refund>();

  constructor(private readonly clock: Clock) {}

  create(label: string, total: Money = zeroMoney("EUR")): Refund {
    if (label.trim().length === 0) {
      throw new DomainError("refund.label_empty", "A refund needs a label");
    }
    const now = this.clock.now();
    const row: Refund = { id: randomUUID(), label: label.trim(), createdAt: now, updatedAt: now, archived: false, total };
    this.rows.set(row.id, row);
    return row;
  }

  get(id: string): Refund {
    const row = this.rows.get(id);
    if (!row) throw new NotFoundError("Refund", id);
    return row;
  }

  rename(id: string, label: string): Refund {
    const row = this.get(id);
    const next: Refund = { ...row, label: label.trim(), updatedAt: this.clock.now() };
    this.rows.set(id, next);
    return next;
  }

  addToTotal(id: string, amount: Money): Refund {
    const row = this.get(id);
    // Totals are only ever increased here; refunds go through their own ledger.
    const next: Refund = { ...row, total: addMoney(row.total, amount), updatedAt: this.clock.now() };
    this.rows.set(id, next);
    return next;
  }

  archive(id: string): void {
    const row = this.get(id);
    this.rows.set(id, { ...row, archived: true, updatedAt: this.clock.now() });
  }

  list(cursor: string | null = null, limit = 16): Page<Refund> {
    const all = [...this.rows.values()].filter((row) => !row.archived);
    const start = cursor ? all.findIndex((row) => row.id === cursor) + 1 : 0;
    const items = all.slice(start, start + limit);
    const last = items[items.length - 1];
    return { items, nextCursor: items.length === limit && last ? last.id : null };
  }
}

export function createRepositories(clock: Clock) {
  return {
    invoices: new InvoiceRepository(clock),
    customers: new CustomerRepository(clock),
    shipments: new ShipmentRepository(clock),
    coupons: new CouponRepository(clock),
    warehouses: new WarehouseRepository(clock),
    suppliers: new SupplierRepository(clock),
    refunds: new RefundRepository(clock),
  };
}
