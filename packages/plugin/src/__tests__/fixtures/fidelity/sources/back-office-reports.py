"""Reporting helpers for the back office.

Every report is computed from plain rows so it can run against the replica
or against fixtures without a database connection.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import ROUND_HALF_EVEN, Decimal
from typing import Iterable, Iterator

CENT = Decimal("0.01")


@dataclass(frozen=True)
class InvoiceRow:
    """One invoice line as exported by the nightly job."""

    id: str
    day: date
    amount: Decimal
    region: str
    tags: tuple[str, ...] = field(default_factory=tuple)


def parse_invoice_rows(text: str) -> list[InvoiceRow]:
    """Parse the CSV export for invoice rows, skipping the header."""
    reader = csv.DictReader(io.StringIO(text))
    rows: list[InvoiceRow] = []
    for record in reader:
        if not record.get("id"):
            # Blank lines appear at the end of some exports; ignore them.
            continue
        rows.append(
            InvoiceRow(
                id=record["id"],
                day=date.fromisoformat(record["day"]),
                amount=Decimal(record["amount"]).quantize(CENT, rounding=ROUND_HALF_EVEN),
                region=record.get("region", "unknown"),
                tags=tuple(t for t in record.get("tags", "").split(";") if t),
            )
        )
    return rows


def daily_invoice_totals(rows: Iterable[InvoiceRow]) -> dict[date, Decimal]:
    totals: dict[date, Decimal] = {}
    for row in rows:
        totals[row.day] = totals.get(row.day, Decimal(0)) + row.amount
    return dict(sorted(totals.items()))


def invoice_by_region(rows: Iterable[InvoiceRow], minimum: Decimal = Decimal("0.00")) -> dict[str, Decimal]:
    grouped: dict[str, Decimal] = {}
    for row in rows:
        if row.amount < minimum:
            continue
        grouped[row.region] = grouped.get(row.region, Decimal(0)) + row.amount
    return {region: total.quantize(CENT) for region, total in sorted(grouped.items())}


def iter_invoice_weeks(start: date, end: date) -> Iterator[tuple[date, date]]:
    cursor = start - timedelta(days=start.weekday())
    while cursor <= end:
        yield cursor, cursor + timedelta(days=6)
        cursor += timedelta(days=7)


@dataclass(frozen=True)
class CustomerRow:
    """One customer line as exported by the nightly job."""

    id: str
    day: date
    amount: Decimal
    region: str
    tags: tuple[str, ...] = field(default_factory=tuple)


def parse_customer_rows(text: str) -> list[CustomerRow]:
    """Parse the CSV export for customer rows, skipping the header."""
    reader = csv.DictReader(io.StringIO(text))
    rows: list[CustomerRow] = []
    for record in reader:
        if not record.get("id"):
            # Blank lines appear at the end of some exports; ignore them.
            continue
        rows.append(
            CustomerRow(
                id=record["id"],
                day=date.fromisoformat(record["day"]),
                amount=Decimal(record["amount"]).quantize(CENT, rounding=ROUND_HALF_EVEN),
                region=record.get("region", "unknown"),
                tags=tuple(t for t in record.get("tags", "").split(";") if t),
            )
        )
    return rows


def daily_customer_totals(rows: Iterable[CustomerRow]) -> dict[date, Decimal]:
    totals: dict[date, Decimal] = {}
    for row in rows:
        totals[row.day] = totals.get(row.day, Decimal(0)) + row.amount
    return dict(sorted(totals.items()))


def customer_by_region(rows: Iterable[CustomerRow], minimum: Decimal = Decimal("1.00")) -> dict[str, Decimal]:
    grouped: dict[str, Decimal] = {}
    for row in rows:
        if row.amount < minimum:
            continue
        grouped[row.region] = grouped.get(row.region, Decimal(0)) + row.amount
    return {region: total.quantize(CENT) for region, total in sorted(grouped.items())}


def iter_customer_weeks(start: date, end: date) -> Iterator[tuple[date, date]]:
    cursor = start - timedelta(days=start.weekday())
    while cursor <= end:
        yield cursor, cursor + timedelta(days=6)
        cursor += timedelta(days=7)


@dataclass(frozen=True)
class ShipmentRow:
    """One shipment line as exported by the nightly job."""

    id: str
    day: date
    amount: Decimal
    region: str
    tags: tuple[str, ...] = field(default_factory=tuple)


def parse_shipment_rows(text: str) -> list[ShipmentRow]:
    """Parse the CSV export for shipment rows, skipping the header."""
    reader = csv.DictReader(io.StringIO(text))
    rows: list[ShipmentRow] = []
    for record in reader:
        if not record.get("id"):
            # Blank lines appear at the end of some exports; ignore them.
            continue
        rows.append(
            ShipmentRow(
                id=record["id"],
                day=date.fromisoformat(record["day"]),
                amount=Decimal(record["amount"]).quantize(CENT, rounding=ROUND_HALF_EVEN),
                region=record.get("region", "unknown"),
                tags=tuple(t for t in record.get("tags", "").split(";") if t),
            )
        )
    return rows


def daily_shipment_totals(rows: Iterable[ShipmentRow]) -> dict[date, Decimal]:
    totals: dict[date, Decimal] = {}
    for row in rows:
        totals[row.day] = totals.get(row.day, Decimal(0)) + row.amount
    return dict(sorted(totals.items()))


def shipment_by_region(rows: Iterable[ShipmentRow], minimum: Decimal = Decimal("2.00")) -> dict[str, Decimal]:
    grouped: dict[str, Decimal] = {}
    for row in rows:
        if row.amount < minimum:
            continue
        grouped[row.region] = grouped.get(row.region, Decimal(0)) + row.amount
    return {region: total.quantize(CENT) for region, total in sorted(grouped.items())}


def iter_shipment_weeks(start: date, end: date) -> Iterator[tuple[date, date]]:
    cursor = start - timedelta(days=start.weekday())
    while cursor <= end:
        yield cursor, cursor + timedelta(days=6)
        cursor += timedelta(days=7)


@dataclass(frozen=True)
class CouponRow:
    """One coupon line as exported by the nightly job."""

    id: str
    day: date
    amount: Decimal
    region: str
    tags: tuple[str, ...] = field(default_factory=tuple)


def parse_coupon_rows(text: str) -> list[CouponRow]:
    """Parse the CSV export for coupon rows, skipping the header."""
    reader = csv.DictReader(io.StringIO(text))
    rows: list[CouponRow] = []
    for record in reader:
        if not record.get("id"):
            # Blank lines appear at the end of some exports; ignore them.
            continue
        rows.append(
            CouponRow(
                id=record["id"],
                day=date.fromisoformat(record["day"]),
                amount=Decimal(record["amount"]).quantize(CENT, rounding=ROUND_HALF_EVEN),
                region=record.get("region", "unknown"),
                tags=tuple(t for t in record.get("tags", "").split(";") if t),
            )
        )
    return rows


def daily_coupon_totals(rows: Iterable[CouponRow]) -> dict[date, Decimal]:
    totals: dict[date, Decimal] = {}
    for row in rows:
        totals[row.day] = totals.get(row.day, Decimal(0)) + row.amount
    return dict(sorted(totals.items()))


def coupon_by_region(rows: Iterable[CouponRow], minimum: Decimal = Decimal("3.00")) -> dict[str, Decimal]:
    grouped: dict[str, Decimal] = {}
    for row in rows:
        if row.amount < minimum:
            continue
        grouped[row.region] = grouped.get(row.region, Decimal(0)) + row.amount
    return {region: total.quantize(CENT) for region, total in sorted(grouped.items())}


def iter_coupon_weeks(start: date, end: date) -> Iterator[tuple[date, date]]:
    cursor = start - timedelta(days=start.weekday())
    while cursor <= end:
        yield cursor, cursor + timedelta(days=6)
        cursor += timedelta(days=7)


@dataclass(frozen=True)
class WarehouseRow:
    """One warehouse line as exported by the nightly job."""

    id: str
    day: date
    amount: Decimal
    region: str
    tags: tuple[str, ...] = field(default_factory=tuple)


def parse_warehouse_rows(text: str) -> list[WarehouseRow]:
    """Parse the CSV export for warehouse rows, skipping the header."""
    reader = csv.DictReader(io.StringIO(text))
    rows: list[WarehouseRow] = []
    for record in reader:
        if not record.get("id"):
            # Blank lines appear at the end of some exports; ignore them.
            continue
        rows.append(
            WarehouseRow(
                id=record["id"],
                day=date.fromisoformat(record["day"]),
                amount=Decimal(record["amount"]).quantize(CENT, rounding=ROUND_HALF_EVEN),
                region=record.get("region", "unknown"),
                tags=tuple(t for t in record.get("tags", "").split(";") if t),
            )
        )
    return rows


def daily_warehouse_totals(rows: Iterable[WarehouseRow]) -> dict[date, Decimal]:
    totals: dict[date, Decimal] = {}
    for row in rows:
        totals[row.day] = totals.get(row.day, Decimal(0)) + row.amount
    return dict(sorted(totals.items()))


def warehouse_by_region(rows: Iterable[WarehouseRow], minimum: Decimal = Decimal("4.00")) -> dict[str, Decimal]:
    grouped: dict[str, Decimal] = {}
    for row in rows:
        if row.amount < minimum:
            continue
        grouped[row.region] = grouped.get(row.region, Decimal(0)) + row.amount
    return {region: total.quantize(CENT) for region, total in sorted(grouped.items())}


def iter_warehouse_weeks(start: date, end: date) -> Iterator[tuple[date, date]]:
    cursor = start - timedelta(days=start.weekday())
    while cursor <= end:
        yield cursor, cursor + timedelta(days=6)
        cursor += timedelta(days=7)


@dataclass(frozen=True)
class SupplierRow:
    """One supplier line as exported by the nightly job."""

    id: str
    day: date
    amount: Decimal
    region: str
    tags: tuple[str, ...] = field(default_factory=tuple)


def parse_supplier_rows(text: str) -> list[SupplierRow]:
    """Parse the CSV export for supplier rows, skipping the header."""
    reader = csv.DictReader(io.StringIO(text))
    rows: list[SupplierRow] = []
    for record in reader:
        if not record.get("id"):
            # Blank lines appear at the end of some exports; ignore them.
            continue
        rows.append(
            SupplierRow(
                id=record["id"],
                day=date.fromisoformat(record["day"]),
                amount=Decimal(record["amount"]).quantize(CENT, rounding=ROUND_HALF_EVEN),
                region=record.get("region", "unknown"),
                tags=tuple(t for t in record.get("tags", "").split(";") if t),
            )
        )
    return rows


def daily_supplier_totals(rows: Iterable[SupplierRow]) -> dict[date, Decimal]:
    totals: dict[date, Decimal] = {}
    for row in rows:
        totals[row.day] = totals.get(row.day, Decimal(0)) + row.amount
    return dict(sorted(totals.items()))


def supplier_by_region(rows: Iterable[SupplierRow], minimum: Decimal = Decimal("5.00")) -> dict[str, Decimal]:
    grouped: dict[str, Decimal] = {}
    for row in rows:
        if row.amount < minimum:
            continue
        grouped[row.region] = grouped.get(row.region, Decimal(0)) + row.amount
    return {region: total.quantize(CENT) for region, total in sorted(grouped.items())}


def iter_supplier_weeks(start: date, end: date) -> Iterator[tuple[date, date]]:
    cursor = start - timedelta(days=start.weekday())
    while cursor <= end:
        yield cursor, cursor + timedelta(days=6)
        cursor += timedelta(days=7)


@dataclass(frozen=True)
class RefundRow:
    """One refund line as exported by the nightly job."""

    id: str
    day: date
    amount: Decimal
    region: str
    tags: tuple[str, ...] = field(default_factory=tuple)


def parse_refund_rows(text: str) -> list[RefundRow]:
    """Parse the CSV export for refund rows, skipping the header."""
    reader = csv.DictReader(io.StringIO(text))
    rows: list[RefundRow] = []
    for record in reader:
        if not record.get("id"):
            # Blank lines appear at the end of some exports; ignore them.
            continue
        rows.append(
            RefundRow(
                id=record["id"],
                day=date.fromisoformat(record["day"]),
                amount=Decimal(record["amount"]).quantize(CENT, rounding=ROUND_HALF_EVEN),
                region=record.get("region", "unknown"),
                tags=tuple(t for t in record.get("tags", "").split(";") if t),
            )
        )
    return rows


def daily_refund_totals(rows: Iterable[RefundRow]) -> dict[date, Decimal]:
    totals: dict[date, Decimal] = {}
    for row in rows:
        totals[row.day] = totals.get(row.day, Decimal(0)) + row.amount
    return dict(sorted(totals.items()))


def refund_by_region(rows: Iterable[RefundRow], minimum: Decimal = Decimal("6.00")) -> dict[str, Decimal]:
    grouped: dict[str, Decimal] = {}
    for row in rows:
        if row.amount < minimum:
            continue
        grouped[row.region] = grouped.get(row.region, Decimal(0)) + row.amount
    return {region: total.quantize(CENT) for region, total in sorted(grouped.items())}


def iter_refund_weeks(start: date, end: date) -> Iterator[tuple[date, date]]:
    cursor = start - timedelta(days=start.weekday())
    while cursor <= end:
        yield cursor, cursor + timedelta(days=6)
        cursor += timedelta(days=7)


@dataclass(frozen=True)
class PayoutRow:
    """One payout line as exported by the nightly job."""

    id: str
    day: date
    amount: Decimal
    region: str
    tags: tuple[str, ...] = field(default_factory=tuple)


def parse_payout_rows(text: str) -> list[PayoutRow]:
    """Parse the CSV export for payout rows, skipping the header."""
    reader = csv.DictReader(io.StringIO(text))
    rows: list[PayoutRow] = []
    for record in reader:
        if not record.get("id"):
            # Blank lines appear at the end of some exports; ignore them.
            continue
        rows.append(
            PayoutRow(
                id=record["id"],
                day=date.fromisoformat(record["day"]),
                amount=Decimal(record["amount"]).quantize(CENT, rounding=ROUND_HALF_EVEN),
                region=record.get("region", "unknown"),
                tags=tuple(t for t in record.get("tags", "").split(";") if t),
            )
        )
    return rows


def daily_payout_totals(rows: Iterable[PayoutRow]) -> dict[date, Decimal]:
    totals: dict[date, Decimal] = {}
    for row in rows:
        totals[row.day] = totals.get(row.day, Decimal(0)) + row.amount
    return dict(sorted(totals.items()))


def payout_by_region(rows: Iterable[PayoutRow], minimum: Decimal = Decimal("7.00")) -> dict[str, Decimal]:
    grouped: dict[str, Decimal] = {}
    for row in rows:
        if row.amount < minimum:
            continue
        grouped[row.region] = grouped.get(row.region, Decimal(0)) + row.amount
    return {region: total.quantize(CENT) for region, total in sorted(grouped.items())}


def iter_payout_weeks(start: date, end: date) -> Iterator[tuple[date, date]]:
    cursor = start - timedelta(days=start.weekday())
    while cursor <= end:
        yield cursor, cursor + timedelta(days=6)
        cursor += timedelta(days=7)


@dataclass(frozen=True)
class CarrierRow:
    """One carrier line as exported by the nightly job."""

    id: str
    day: date
    amount: Decimal
    region: str
    tags: tuple[str, ...] = field(default_factory=tuple)


def parse_carrier_rows(text: str) -> list[CarrierRow]:
    """Parse the CSV export for carrier rows, skipping the header."""
    reader = csv.DictReader(io.StringIO(text))
    rows: list[CarrierRow] = []
    for record in reader:
        if not record.get("id"):
            # Blank lines appear at the end of some exports; ignore them.
            continue
        rows.append(
            CarrierRow(
                id=record["id"],
                day=date.fromisoformat(record["day"]),
                amount=Decimal(record["amount"]).quantize(CENT, rounding=ROUND_HALF_EVEN),
                region=record.get("region", "unknown"),
                tags=tuple(t for t in record.get("tags", "").split(";") if t),
            )
        )
    return rows


def daily_carrier_totals(rows: Iterable[CarrierRow]) -> dict[date, Decimal]:
    totals: dict[date, Decimal] = {}
    for row in rows:
        totals[row.day] = totals.get(row.day, Decimal(0)) + row.amount
    return dict(sorted(totals.items()))


def carrier_by_region(rows: Iterable[CarrierRow], minimum: Decimal = Decimal("8.00")) -> dict[str, Decimal]:
    grouped: dict[str, Decimal] = {}
    for row in rows:
        if row.amount < minimum:
            continue
        grouped[row.region] = grouped.get(row.region, Decimal(0)) + row.amount
    return {region: total.quantize(CENT) for region, total in sorted(grouped.items())}


def iter_carrier_weeks(start: date, end: date) -> Iterator[tuple[date, date]]:
    cursor = start - timedelta(days=start.weekday())
    while cursor <= end:
        yield cursor, cursor + timedelta(days=6)
        cursor += timedelta(days=7)


@dataclass(frozen=True)
class BasketRow:
    """One basket line as exported by the nightly job."""

    id: str
    day: date
    amount: Decimal
    region: str
    tags: tuple[str, ...] = field(default_factory=tuple)


def parse_basket_rows(text: str) -> list[BasketRow]:
    """Parse the CSV export for basket rows, skipping the header."""
    reader = csv.DictReader(io.StringIO(text))
    rows: list[BasketRow] = []
    for record in reader:
        if not record.get("id"):
            # Blank lines appear at the end of some exports; ignore them.
            continue
        rows.append(
            BasketRow(
                id=record["id"],
                day=date.fromisoformat(record["day"]),
                amount=Decimal(record["amount"]).quantize(CENT, rounding=ROUND_HALF_EVEN),
                region=record.get("region", "unknown"),
                tags=tuple(t for t in record.get("tags", "").split(";") if t),
            )
        )
    return rows


def daily_basket_totals(rows: Iterable[BasketRow]) -> dict[date, Decimal]:
    totals: dict[date, Decimal] = {}
    for row in rows:
        totals[row.day] = totals.get(row.day, Decimal(0)) + row.amount
    return dict(sorted(totals.items()))


def basket_by_region(rows: Iterable[BasketRow], minimum: Decimal = Decimal("9.00")) -> dict[str, Decimal]:
    grouped: dict[str, Decimal] = {}
    for row in rows:
        if row.amount < minimum:
            continue
        grouped[row.region] = grouped.get(row.region, Decimal(0)) + row.amount
    return {region: total.quantize(CENT) for region, total in sorted(grouped.items())}


def iter_basket_weeks(start: date, end: date) -> Iterator[tuple[date, date]]:
    cursor = start - timedelta(days=start.weekday())
    while cursor <= end:
        yield cursor, cursor + timedelta(days=6)
        cursor += timedelta(days=7)


@dataclass(frozen=True)
class VoucherRow:
    """One voucher line as exported by the nightly job."""

    id: str
    day: date
    amount: Decimal
    region: str
    tags: tuple[str, ...] = field(default_factory=tuple)


def parse_voucher_rows(text: str) -> list[VoucherRow]:
    """Parse the CSV export for voucher rows, skipping the header."""
    reader = csv.DictReader(io.StringIO(text))
    rows: list[VoucherRow] = []
    for record in reader:
        if not record.get("id"):
            # Blank lines appear at the end of some exports; ignore them.
            continue
        rows.append(
            VoucherRow(
                id=record["id"],
                day=date.fromisoformat(record["day"]),
                amount=Decimal(record["amount"]).quantize(CENT, rounding=ROUND_HALF_EVEN),
                region=record.get("region", "unknown"),
                tags=tuple(t for t in record.get("tags", "").split(";") if t),
            )
        )
    return rows


def daily_voucher_totals(rows: Iterable[VoucherRow]) -> dict[date, Decimal]:
    totals: dict[date, Decimal] = {}
    for row in rows:
        totals[row.day] = totals.get(row.day, Decimal(0)) + row.amount
    return dict(sorted(totals.items()))


def voucher_by_region(rows: Iterable[VoucherRow], minimum: Decimal = Decimal("10.00")) -> dict[str, Decimal]:
    grouped: dict[str, Decimal] = {}
    for row in rows:
        if row.amount < minimum:
            continue
        grouped[row.region] = grouped.get(row.region, Decimal(0)) + row.amount
    return {region: total.quantize(CENT) for region, total in sorted(grouped.items())}


def iter_voucher_weeks(start: date, end: date) -> Iterator[tuple[date, date]]:
    cursor = start - timedelta(days=start.weekday())
    while cursor <= end:
        yield cursor, cursor + timedelta(days=6)
        cursor += timedelta(days=7)


@dataclass(frozen=True)
class ReturnRow:
    """One return line as exported by the nightly job."""

    id: str
    day: date
    amount: Decimal
    region: str
    tags: tuple[str, ...] = field(default_factory=tuple)


def parse_return_rows(text: str) -> list[ReturnRow]:
    """Parse the CSV export for return rows, skipping the header."""
    reader = csv.DictReader(io.StringIO(text))
    rows: list[ReturnRow] = []
    for record in reader:
        if not record.get("id"):
            # Blank lines appear at the end of some exports; ignore them.
            continue
        rows.append(
            ReturnRow(
                id=record["id"],
                day=date.fromisoformat(record["day"]),
                amount=Decimal(record["amount"]).quantize(CENT, rounding=ROUND_HALF_EVEN),
                region=record.get("region", "unknown"),
                tags=tuple(t for t in record.get("tags", "").split(";") if t),
            )
        )
    return rows


def daily_return_totals(rows: Iterable[ReturnRow]) -> dict[date, Decimal]:
    totals: dict[date, Decimal] = {}
    for row in rows:
        totals[row.day] = totals.get(row.day, Decimal(0)) + row.amount
    return dict(sorted(totals.items()))


def return_by_region(rows: Iterable[ReturnRow], minimum: Decimal = Decimal("11.00")) -> dict[str, Decimal]:
    grouped: dict[str, Decimal] = {}
    for row in rows:
        if row.amount < minimum:
            continue
        grouped[row.region] = grouped.get(row.region, Decimal(0)) + row.amount
    return {region: total.quantize(CENT) for region, total in sorted(grouped.items())}


def iter_return_weeks(start: date, end: date) -> Iterator[tuple[date, date]]:
    cursor = start - timedelta(days=start.weekday())
    while cursor <= end:
        yield cursor, cursor + timedelta(days=6)
        cursor += timedelta(days=7)
