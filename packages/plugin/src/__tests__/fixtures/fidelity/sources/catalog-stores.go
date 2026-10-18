package catalog

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// ErrNotFound is returned when a lookup misses.
var ErrNotFound = errors.New("catalog: not found")

// Invoice is the stored form of a invoice.
type Invoice struct {
	ID        string
	Name      string
	PriceCents int64
	Tags      []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// InvoiceStore keeps invoice values in memory behind a mutex.
type InvoiceStore struct {
	mu   sync.RWMutex
	rows map[string]Invoice
	now  func() time.Time
}

func NewInvoiceStore(now func() time.Time) *InvoiceStore {
	return &InvoiceStore{rows: make(map[string]Invoice), now: now}
}

func (s *InvoiceStore) Put(ctx context.Context, item Invoice) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(item.Name) == "" {
		return fmt.Errorf("invoice: empty name for %q", item.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if existing, ok := s.rows[item.ID]; ok {
		item.CreatedAt = existing.CreatedAt
	} else {
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	s.rows[item.ID] = item
	return nil
}

func (s *InvoiceStore) Get(id string) (Invoice, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.rows[id]
	if !ok {
		return Invoice{}, fmt.Errorf("invoice %q: %w", id, ErrNotFound)
	}
	return item, nil
}

func (s *InvoiceStore) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.rows[id]
	delete(s.rows, id)
	return ok
}

// Cheapest returns at most limit invoice values sorted by price, then by name.
func (s *InvoiceStore) Cheapest(limit int) []Invoice {
	s.mu.RLock()
	out := make([]Invoice, 0, len(s.rows))
	for _, item := range s.rows {
		out = append(out, item)
	}
	s.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].PriceCents != out[j].PriceCents {
			return out[i].PriceCents < out[j].PriceCents
		}
		return out[i].Name < out[j].Name
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *InvoiceStore) WithTag(tag string) []Invoice {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Invoice
	for _, item := range s.rows {
		for _, t := range item.Tags {
			if strings.EqualFold(t, tag) {
				out = append(out, item)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Customer is the stored form of a customer.
type Customer struct {
	ID        string
	Name      string
	PriceCents int64
	Tags      []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// CustomerStore keeps customer values in memory behind a mutex.
type CustomerStore struct {
	mu   sync.RWMutex
	rows map[string]Customer
	now  func() time.Time
}

func NewCustomerStore(now func() time.Time) *CustomerStore {
	return &CustomerStore{rows: make(map[string]Customer), now: now}
}

func (s *CustomerStore) Put(ctx context.Context, item Customer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(item.Name) == "" {
		return fmt.Errorf("customer: empty name for %q", item.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if existing, ok := s.rows[item.ID]; ok {
		item.CreatedAt = existing.CreatedAt
	} else {
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	s.rows[item.ID] = item
	return nil
}

func (s *CustomerStore) Get(id string) (Customer, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.rows[id]
	if !ok {
		return Customer{}, fmt.Errorf("customer %q: %w", id, ErrNotFound)
	}
	return item, nil
}

func (s *CustomerStore) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.rows[id]
	delete(s.rows, id)
	return ok
}

// Cheapest returns at most limit customer values sorted by price, then by name.
func (s *CustomerStore) Cheapest(limit int) []Customer {
	s.mu.RLock()
	out := make([]Customer, 0, len(s.rows))
	for _, item := range s.rows {
		out = append(out, item)
	}
	s.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].PriceCents != out[j].PriceCents {
			return out[i].PriceCents < out[j].PriceCents
		}
		return out[i].Name < out[j].Name
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *CustomerStore) WithTag(tag string) []Customer {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Customer
	for _, item := range s.rows {
		for _, t := range item.Tags {
			if strings.EqualFold(t, tag) {
				out = append(out, item)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Shipment is the stored form of a shipment.
type Shipment struct {
	ID        string
	Name      string
	PriceCents int64
	Tags      []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// ShipmentStore keeps shipment values in memory behind a mutex.
type ShipmentStore struct {
	mu   sync.RWMutex
	rows map[string]Shipment
	now  func() time.Time
}

func NewShipmentStore(now func() time.Time) *ShipmentStore {
	return &ShipmentStore{rows: make(map[string]Shipment), now: now}
}

func (s *ShipmentStore) Put(ctx context.Context, item Shipment) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(item.Name) == "" {
		return fmt.Errorf("shipment: empty name for %q", item.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if existing, ok := s.rows[item.ID]; ok {
		item.CreatedAt = existing.CreatedAt
	} else {
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	s.rows[item.ID] = item
	return nil
}

func (s *ShipmentStore) Get(id string) (Shipment, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.rows[id]
	if !ok {
		return Shipment{}, fmt.Errorf("shipment %q: %w", id, ErrNotFound)
	}
	return item, nil
}

func (s *ShipmentStore) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.rows[id]
	delete(s.rows, id)
	return ok
}

// Cheapest returns at most limit shipment values sorted by price, then by name.
func (s *ShipmentStore) Cheapest(limit int) []Shipment {
	s.mu.RLock()
	out := make([]Shipment, 0, len(s.rows))
	for _, item := range s.rows {
		out = append(out, item)
	}
	s.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].PriceCents != out[j].PriceCents {
			return out[i].PriceCents < out[j].PriceCents
		}
		return out[i].Name < out[j].Name
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *ShipmentStore) WithTag(tag string) []Shipment {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Shipment
	for _, item := range s.rows {
		for _, t := range item.Tags {
			if strings.EqualFold(t, tag) {
				out = append(out, item)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Coupon is the stored form of a coupon.
type Coupon struct {
	ID        string
	Name      string
	PriceCents int64
	Tags      []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// CouponStore keeps coupon values in memory behind a mutex.
type CouponStore struct {
	mu   sync.RWMutex
	rows map[string]Coupon
	now  func() time.Time
}

func NewCouponStore(now func() time.Time) *CouponStore {
	return &CouponStore{rows: make(map[string]Coupon), now: now}
}

func (s *CouponStore) Put(ctx context.Context, item Coupon) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(item.Name) == "" {
		return fmt.Errorf("coupon: empty name for %q", item.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if existing, ok := s.rows[item.ID]; ok {
		item.CreatedAt = existing.CreatedAt
	} else {
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	s.rows[item.ID] = item
	return nil
}

func (s *CouponStore) Get(id string) (Coupon, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.rows[id]
	if !ok {
		return Coupon{}, fmt.Errorf("coupon %q: %w", id, ErrNotFound)
	}
	return item, nil
}

func (s *CouponStore) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.rows[id]
	delete(s.rows, id)
	return ok
}

// Cheapest returns at most limit coupon values sorted by price, then by name.
func (s *CouponStore) Cheapest(limit int) []Coupon {
	s.mu.RLock()
	out := make([]Coupon, 0, len(s.rows))
	for _, item := range s.rows {
		out = append(out, item)
	}
	s.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].PriceCents != out[j].PriceCents {
			return out[i].PriceCents < out[j].PriceCents
		}
		return out[i].Name < out[j].Name
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *CouponStore) WithTag(tag string) []Coupon {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Coupon
	for _, item := range s.rows {
		for _, t := range item.Tags {
			if strings.EqualFold(t, tag) {
				out = append(out, item)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Warehouse is the stored form of a warehouse.
type Warehouse struct {
	ID        string
	Name      string
	PriceCents int64
	Tags      []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// WarehouseStore keeps warehouse values in memory behind a mutex.
type WarehouseStore struct {
	mu   sync.RWMutex
	rows map[string]Warehouse
	now  func() time.Time
}

func NewWarehouseStore(now func() time.Time) *WarehouseStore {
	return &WarehouseStore{rows: make(map[string]Warehouse), now: now}
}

func (s *WarehouseStore) Put(ctx context.Context, item Warehouse) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(item.Name) == "" {
		return fmt.Errorf("warehouse: empty name for %q", item.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if existing, ok := s.rows[item.ID]; ok {
		item.CreatedAt = existing.CreatedAt
	} else {
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	s.rows[item.ID] = item
	return nil
}

func (s *WarehouseStore) Get(id string) (Warehouse, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.rows[id]
	if !ok {
		return Warehouse{}, fmt.Errorf("warehouse %q: %w", id, ErrNotFound)
	}
	return item, nil
}

func (s *WarehouseStore) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.rows[id]
	delete(s.rows, id)
	return ok
}

// Cheapest returns at most limit warehouse values sorted by price, then by name.
func (s *WarehouseStore) Cheapest(limit int) []Warehouse {
	s.mu.RLock()
	out := make([]Warehouse, 0, len(s.rows))
	for _, item := range s.rows {
		out = append(out, item)
	}
	s.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].PriceCents != out[j].PriceCents {
			return out[i].PriceCents < out[j].PriceCents
		}
		return out[i].Name < out[j].Name
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *WarehouseStore) WithTag(tag string) []Warehouse {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Warehouse
	for _, item := range s.rows {
		for _, t := range item.Tags {
			if strings.EqualFold(t, tag) {
				out = append(out, item)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Supplier is the stored form of a supplier.
type Supplier struct {
	ID        string
	Name      string
	PriceCents int64
	Tags      []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// SupplierStore keeps supplier values in memory behind a mutex.
type SupplierStore struct {
	mu   sync.RWMutex
	rows map[string]Supplier
	now  func() time.Time
}

func NewSupplierStore(now func() time.Time) *SupplierStore {
	return &SupplierStore{rows: make(map[string]Supplier), now: now}
}

func (s *SupplierStore) Put(ctx context.Context, item Supplier) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(item.Name) == "" {
		return fmt.Errorf("supplier: empty name for %q", item.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if existing, ok := s.rows[item.ID]; ok {
		item.CreatedAt = existing.CreatedAt
	} else {
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	s.rows[item.ID] = item
	return nil
}

func (s *SupplierStore) Get(id string) (Supplier, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.rows[id]
	if !ok {
		return Supplier{}, fmt.Errorf("supplier %q: %w", id, ErrNotFound)
	}
	return item, nil
}

func (s *SupplierStore) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.rows[id]
	delete(s.rows, id)
	return ok
}

// Cheapest returns at most limit supplier values sorted by price, then by name.
func (s *SupplierStore) Cheapest(limit int) []Supplier {
	s.mu.RLock()
	out := make([]Supplier, 0, len(s.rows))
	for _, item := range s.rows {
		out = append(out, item)
	}
	s.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].PriceCents != out[j].PriceCents {
			return out[i].PriceCents < out[j].PriceCents
		}
		return out[i].Name < out[j].Name
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *SupplierStore) WithTag(tag string) []Supplier {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Supplier
	for _, item := range s.rows {
		for _, t := range item.Tags {
			if strings.EqualFold(t, tag) {
				out = append(out, item)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Refund is the stored form of a refund.
type Refund struct {
	ID        string
	Name      string
	PriceCents int64
	Tags      []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// RefundStore keeps refund values in memory behind a mutex.
type RefundStore struct {
	mu   sync.RWMutex
	rows map[string]Refund
	now  func() time.Time
}

func NewRefundStore(now func() time.Time) *RefundStore {
	return &RefundStore{rows: make(map[string]Refund), now: now}
}

func (s *RefundStore) Put(ctx context.Context, item Refund) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(item.Name) == "" {
		return fmt.Errorf("refund: empty name for %q", item.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if existing, ok := s.rows[item.ID]; ok {
		item.CreatedAt = existing.CreatedAt
	} else {
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	s.rows[item.ID] = item
	return nil
}

func (s *RefundStore) Get(id string) (Refund, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.rows[id]
	if !ok {
		return Refund{}, fmt.Errorf("refund %q: %w", id, ErrNotFound)
	}
	return item, nil
}

func (s *RefundStore) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.rows[id]
	delete(s.rows, id)
	return ok
}

// Cheapest returns at most limit refund values sorted by price, then by name.
func (s *RefundStore) Cheapest(limit int) []Refund {
	s.mu.RLock()
	out := make([]Refund, 0, len(s.rows))
	for _, item := range s.rows {
		out = append(out, item)
	}
	s.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].PriceCents != out[j].PriceCents {
			return out[i].PriceCents < out[j].PriceCents
		}
		return out[i].Name < out[j].Name
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *RefundStore) WithTag(tag string) []Refund {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Refund
	for _, item := range s.rows {
		for _, t := range item.Tags {
			if strings.EqualFold(t, tag) {
				out = append(out, item)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Payout is the stored form of a payout.
type Payout struct {
	ID        string
	Name      string
	PriceCents int64
	Tags      []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// PayoutStore keeps payout values in memory behind a mutex.
type PayoutStore struct {
	mu   sync.RWMutex
	rows map[string]Payout
	now  func() time.Time
}

func NewPayoutStore(now func() time.Time) *PayoutStore {
	return &PayoutStore{rows: make(map[string]Payout), now: now}
}

func (s *PayoutStore) Put(ctx context.Context, item Payout) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(item.Name) == "" {
		return fmt.Errorf("payout: empty name for %q", item.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if existing, ok := s.rows[item.ID]; ok {
		item.CreatedAt = existing.CreatedAt
	} else {
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	s.rows[item.ID] = item
	return nil
}

func (s *PayoutStore) Get(id string) (Payout, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.rows[id]
	if !ok {
		return Payout{}, fmt.Errorf("payout %q: %w", id, ErrNotFound)
	}
	return item, nil
}

func (s *PayoutStore) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.rows[id]
	delete(s.rows, id)
	return ok
}

// Cheapest returns at most limit payout values sorted by price, then by name.
func (s *PayoutStore) Cheapest(limit int) []Payout {
	s.mu.RLock()
	out := make([]Payout, 0, len(s.rows))
	for _, item := range s.rows {
		out = append(out, item)
	}
	s.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].PriceCents != out[j].PriceCents {
			return out[i].PriceCents < out[j].PriceCents
		}
		return out[i].Name < out[j].Name
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *PayoutStore) WithTag(tag string) []Payout {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Payout
	for _, item := range s.rows {
		for _, t := range item.Tags {
			if strings.EqualFold(t, tag) {
				out = append(out, item)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Carrier is the stored form of a carrier.
type Carrier struct {
	ID        string
	Name      string
	PriceCents int64
	Tags      []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// CarrierStore keeps carrier values in memory behind a mutex.
type CarrierStore struct {
	mu   sync.RWMutex
	rows map[string]Carrier
	now  func() time.Time
}

func NewCarrierStore(now func() time.Time) *CarrierStore {
	return &CarrierStore{rows: make(map[string]Carrier), now: now}
}

func (s *CarrierStore) Put(ctx context.Context, item Carrier) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(item.Name) == "" {
		return fmt.Errorf("carrier: empty name for %q", item.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if existing, ok := s.rows[item.ID]; ok {
		item.CreatedAt = existing.CreatedAt
	} else {
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	s.rows[item.ID] = item
	return nil
}

func (s *CarrierStore) Get(id string) (Carrier, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.rows[id]
	if !ok {
		return Carrier{}, fmt.Errorf("carrier %q: %w", id, ErrNotFound)
	}
	return item, nil
}

func (s *CarrierStore) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.rows[id]
	delete(s.rows, id)
	return ok
}

// Cheapest returns at most limit carrier values sorted by price, then by name.
func (s *CarrierStore) Cheapest(limit int) []Carrier {
	s.mu.RLock()
	out := make([]Carrier, 0, len(s.rows))
	for _, item := range s.rows {
		out = append(out, item)
	}
	s.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].PriceCents != out[j].PriceCents {
			return out[i].PriceCents < out[j].PriceCents
		}
		return out[i].Name < out[j].Name
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *CarrierStore) WithTag(tag string) []Carrier {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Carrier
	for _, item := range s.rows {
		for _, t := range item.Tags {
			if strings.EqualFold(t, tag) {
				out = append(out, item)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Basket is the stored form of a basket.
type Basket struct {
	ID        string
	Name      string
	PriceCents int64
	Tags      []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// BasketStore keeps basket values in memory behind a mutex.
type BasketStore struct {
	mu   sync.RWMutex
	rows map[string]Basket
	now  func() time.Time
}

func NewBasketStore(now func() time.Time) *BasketStore {
	return &BasketStore{rows: make(map[string]Basket), now: now}
}

func (s *BasketStore) Put(ctx context.Context, item Basket) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(item.Name) == "" {
		return fmt.Errorf("basket: empty name for %q", item.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if existing, ok := s.rows[item.ID]; ok {
		item.CreatedAt = existing.CreatedAt
	} else {
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	s.rows[item.ID] = item
	return nil
}

func (s *BasketStore) Get(id string) (Basket, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.rows[id]
	if !ok {
		return Basket{}, fmt.Errorf("basket %q: %w", id, ErrNotFound)
	}
	return item, nil
}

func (s *BasketStore) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.rows[id]
	delete(s.rows, id)
	return ok
}

// Cheapest returns at most limit basket values sorted by price, then by name.
func (s *BasketStore) Cheapest(limit int) []Basket {
	s.mu.RLock()
	out := make([]Basket, 0, len(s.rows))
	for _, item := range s.rows {
		out = append(out, item)
	}
	s.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].PriceCents != out[j].PriceCents {
			return out[i].PriceCents < out[j].PriceCents
		}
		return out[i].Name < out[j].Name
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *BasketStore) WithTag(tag string) []Basket {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Basket
	for _, item := range s.rows {
		for _, t := range item.Tags {
			if strings.EqualFold(t, tag) {
				out = append(out, item)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Voucher is the stored form of a voucher.
type Voucher struct {
	ID        string
	Name      string
	PriceCents int64
	Tags      []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// VoucherStore keeps voucher values in memory behind a mutex.
type VoucherStore struct {
	mu   sync.RWMutex
	rows map[string]Voucher
	now  func() time.Time
}

func NewVoucherStore(now func() time.Time) *VoucherStore {
	return &VoucherStore{rows: make(map[string]Voucher), now: now}
}

func (s *VoucherStore) Put(ctx context.Context, item Voucher) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(item.Name) == "" {
		return fmt.Errorf("voucher: empty name for %q", item.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if existing, ok := s.rows[item.ID]; ok {
		item.CreatedAt = existing.CreatedAt
	} else {
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	s.rows[item.ID] = item
	return nil
}

func (s *VoucherStore) Get(id string) (Voucher, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.rows[id]
	if !ok {
		return Voucher{}, fmt.Errorf("voucher %q: %w", id, ErrNotFound)
	}
	return item, nil
}

func (s *VoucherStore) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.rows[id]
	delete(s.rows, id)
	return ok
}

// Cheapest returns at most limit voucher values sorted by price, then by name.
func (s *VoucherStore) Cheapest(limit int) []Voucher {
	s.mu.RLock()
	out := make([]Voucher, 0, len(s.rows))
	for _, item := range s.rows {
		out = append(out, item)
	}
	s.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].PriceCents != out[j].PriceCents {
			return out[i].PriceCents < out[j].PriceCents
		}
		return out[i].Name < out[j].Name
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *VoucherStore) WithTag(tag string) []Voucher {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Voucher
	for _, item := range s.rows {
		for _, t := range item.Tags {
			if strings.EqualFold(t, tag) {
				out = append(out, item)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Return is the stored form of a return.
type Return struct {
	ID        string
	Name      string
	PriceCents int64
	Tags      []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// ReturnStore keeps return values in memory behind a mutex.
type ReturnStore struct {
	mu   sync.RWMutex
	rows map[string]Return
	now  func() time.Time
}

func NewReturnStore(now func() time.Time) *ReturnStore {
	return &ReturnStore{rows: make(map[string]Return), now: now}
}

func (s *ReturnStore) Put(ctx context.Context, item Return) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(item.Name) == "" {
		return fmt.Errorf("return: empty name for %q", item.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if existing, ok := s.rows[item.ID]; ok {
		item.CreatedAt = existing.CreatedAt
	} else {
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	s.rows[item.ID] = item
	return nil
}

func (s *ReturnStore) Get(id string) (Return, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.rows[id]
	if !ok {
		return Return{}, fmt.Errorf("return %q: %w", id, ErrNotFound)
	}
	return item, nil
}

func (s *ReturnStore) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.rows[id]
	delete(s.rows, id)
	return ok
}

// Cheapest returns at most limit return values sorted by price, then by name.
func (s *ReturnStore) Cheapest(limit int) []Return {
	s.mu.RLock()
	out := make([]Return, 0, len(s.rows))
	for _, item := range s.rows {
		out = append(out, item)
	}
	s.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].PriceCents != out[j].PriceCents {
			return out[i].PriceCents < out[j].PriceCents
		}
		return out[i].Name < out[j].Name
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *ReturnStore) WithTag(tag string) []Return {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Return
	for _, item := range s.rows {
		for _, t := range item.Tags {
			if strings.EqualFold(t, tag) {
				out = append(out, item)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Product is the stored form of a product.
type Product struct {
	ID        string
	Name      string
	PriceCents int64
	Tags      []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// ProductStore keeps product values in memory behind a mutex.
type ProductStore struct {
	mu   sync.RWMutex
	rows map[string]Product
	now  func() time.Time
}

func NewProductStore(now func() time.Time) *ProductStore {
	return &ProductStore{rows: make(map[string]Product), now: now}
}

func (s *ProductStore) Put(ctx context.Context, item Product) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(item.Name) == "" {
		return fmt.Errorf("product: empty name for %q", item.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if existing, ok := s.rows[item.ID]; ok {
		item.CreatedAt = existing.CreatedAt
	} else {
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	s.rows[item.ID] = item
	return nil
}

func (s *ProductStore) Get(id string) (Product, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.rows[id]
	if !ok {
		return Product{}, fmt.Errorf("product %q: %w", id, ErrNotFound)
	}
	return item, nil
}

func (s *ProductStore) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.rows[id]
	delete(s.rows, id)
	return ok
}

// Cheapest returns at most limit product values sorted by price, then by name.
func (s *ProductStore) Cheapest(limit int) []Product {
	s.mu.RLock()
	out := make([]Product, 0, len(s.rows))
	for _, item := range s.rows {
		out = append(out, item)
	}
	s.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].PriceCents != out[j].PriceCents {
			return out[i].PriceCents < out[j].PriceCents
		}
		return out[i].Name < out[j].Name
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *ProductStore) WithTag(tag string) []Product {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Product
	for _, item := range s.rows {
		for _, t := range item.Tags {
			if strings.EqualFold(t, tag) {
				out = append(out, item)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Category is the stored form of a category.
type Category struct {
	ID        string
	Name      string
	PriceCents int64
	Tags      []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// CategoryStore keeps category values in memory behind a mutex.
type CategoryStore struct {
	mu   sync.RWMutex
	rows map[string]Category
	now  func() time.Time
}

func NewCategoryStore(now func() time.Time) *CategoryStore {
	return &CategoryStore{rows: make(map[string]Category), now: now}
}

func (s *CategoryStore) Put(ctx context.Context, item Category) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(item.Name) == "" {
		return fmt.Errorf("category: empty name for %q", item.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if existing, ok := s.rows[item.ID]; ok {
		item.CreatedAt = existing.CreatedAt
	} else {
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	s.rows[item.ID] = item
	return nil
}

func (s *CategoryStore) Get(id string) (Category, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.rows[id]
	if !ok {
		return Category{}, fmt.Errorf("category %q: %w", id, ErrNotFound)
	}
	return item, nil
}

func (s *CategoryStore) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.rows[id]
	delete(s.rows, id)
	return ok
}

// Cheapest returns at most limit category values sorted by price, then by name.
func (s *CategoryStore) Cheapest(limit int) []Category {
	s.mu.RLock()
	out := make([]Category, 0, len(s.rows))
	for _, item := range s.rows {
		out = append(out, item)
	}
	s.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].PriceCents != out[j].PriceCents {
			return out[i].PriceCents < out[j].PriceCents
		}
		return out[i].Name < out[j].Name
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *CategoryStore) WithTag(tag string) []Category {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Category
	for _, item := range s.rows {
		for _, t := range item.Tags {
			if strings.EqualFold(t, tag) {
				out = append(out, item)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Review is the stored form of a review.
type Review struct {
	ID        string
	Name      string
	PriceCents int64
	Tags      []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// ReviewStore keeps review values in memory behind a mutex.
type ReviewStore struct {
	mu   sync.RWMutex
	rows map[string]Review
	now  func() time.Time
}

func NewReviewStore(now func() time.Time) *ReviewStore {
	return &ReviewStore{rows: make(map[string]Review), now: now}
}

func (s *ReviewStore) Put(ctx context.Context, item Review) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(item.Name) == "" {
		return fmt.Errorf("review: empty name for %q", item.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if existing, ok := s.rows[item.ID]; ok {
		item.CreatedAt = existing.CreatedAt
	} else {
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	s.rows[item.ID] = item
	return nil
}

func (s *ReviewStore) Get(id string) (Review, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.rows[id]
	if !ok {
		return Review{}, fmt.Errorf("review %q: %w", id, ErrNotFound)
	}
	return item, nil
}

func (s *ReviewStore) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.rows[id]
	delete(s.rows, id)
	return ok
}

// Cheapest returns at most limit review values sorted by price, then by name.
func (s *ReviewStore) Cheapest(limit int) []Review {
	s.mu.RLock()
	out := make([]Review, 0, len(s.rows))
	for _, item := range s.rows {
		out = append(out, item)
	}
	s.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].PriceCents != out[j].PriceCents {
			return out[i].PriceCents < out[j].PriceCents
		}
		return out[i].Name < out[j].Name
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *ReviewStore) WithTag(tag string) []Review {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Review
	for _, item := range s.rows {
		for _, t := range item.Tags {
			if strings.EqualFold(t, tag) {
				out = append(out, item)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Address is the stored form of a address.
type Address struct {
	ID        string
	Name      string
	PriceCents int64
	Tags      []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// AddressStore keeps address values in memory behind a mutex.
type AddressStore struct {
	mu   sync.RWMutex
	rows map[string]Address
	now  func() time.Time
}

func NewAddressStore(now func() time.Time) *AddressStore {
	return &AddressStore{rows: make(map[string]Address), now: now}
}

func (s *AddressStore) Put(ctx context.Context, item Address) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(item.Name) == "" {
		return fmt.Errorf("address: empty name for %q", item.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if existing, ok := s.rows[item.ID]; ok {
		item.CreatedAt = existing.CreatedAt
	} else {
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	s.rows[item.ID] = item
	return nil
}

func (s *AddressStore) Get(id string) (Address, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.rows[id]
	if !ok {
		return Address{}, fmt.Errorf("address %q: %w", id, ErrNotFound)
	}
	return item, nil
}

func (s *AddressStore) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.rows[id]
	delete(s.rows, id)
	return ok
}

// Cheapest returns at most limit address values sorted by price, then by name.
func (s *AddressStore) Cheapest(limit int) []Address {
	s.mu.RLock()
	out := make([]Address, 0, len(s.rows))
	for _, item := range s.rows {
		out = append(out, item)
	}
	s.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].PriceCents != out[j].PriceCents {
			return out[i].PriceCents < out[j].PriceCents
		}
		return out[i].Name < out[j].Name
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *AddressStore) WithTag(tag string) []Address {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Address
	for _, item := range s.rows {
		for _, t := range item.Tags {
			if strings.EqualFold(t, tag) {
				out = append(out, item)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// TaxRule is the stored form of a taxrule.
type TaxRule struct {
	ID        string
	Name      string
	PriceCents int64
	Tags      []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// TaxRuleStore keeps taxrule values in memory behind a mutex.
type TaxRuleStore struct {
	mu   sync.RWMutex
	rows map[string]TaxRule
	now  func() time.Time
}

func NewTaxRuleStore(now func() time.Time) *TaxRuleStore {
	return &TaxRuleStore{rows: make(map[string]TaxRule), now: now}
}

func (s *TaxRuleStore) Put(ctx context.Context, item TaxRule) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(item.Name) == "" {
		return fmt.Errorf("tax_rule: empty name for %q", item.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if existing, ok := s.rows[item.ID]; ok {
		item.CreatedAt = existing.CreatedAt
	} else {
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	s.rows[item.ID] = item
	return nil
}

func (s *TaxRuleStore) Get(id string) (TaxRule, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.rows[id]
	if !ok {
		return TaxRule{}, fmt.Errorf("tax_rule %q: %w", id, ErrNotFound)
	}
	return item, nil
}

func (s *TaxRuleStore) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.rows[id]
	delete(s.rows, id)
	return ok
}

// Cheapest returns at most limit taxrule values sorted by price, then by name.
func (s *TaxRuleStore) Cheapest(limit int) []TaxRule {
	s.mu.RLock()
	out := make([]TaxRule, 0, len(s.rows))
	for _, item := range s.rows {
		out = append(out, item)
	}
	s.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].PriceCents != out[j].PriceCents {
			return out[i].PriceCents < out[j].PriceCents
		}
		return out[i].Name < out[j].Name
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *TaxRuleStore) WithTag(tag string) []TaxRule {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []TaxRule
	for _, item := range s.rows {
		for _, t := range item.Tags {
			if strings.EqualFold(t, tag) {
				out = append(out, item)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// PriceList is the stored form of a pricelist.
type PriceList struct {
	ID        string
	Name      string
	PriceCents int64
	Tags      []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// PriceListStore keeps pricelist values in memory behind a mutex.
type PriceListStore struct {
	mu   sync.RWMutex
	rows map[string]PriceList
	now  func() time.Time
}

func NewPriceListStore(now func() time.Time) *PriceListStore {
	return &PriceListStore{rows: make(map[string]PriceList), now: now}
}

func (s *PriceListStore) Put(ctx context.Context, item PriceList) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(item.Name) == "" {
		return fmt.Errorf("price_list: empty name for %q", item.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if existing, ok := s.rows[item.ID]; ok {
		item.CreatedAt = existing.CreatedAt
	} else {
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	s.rows[item.ID] = item
	return nil
}

func (s *PriceListStore) Get(id string) (PriceList, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.rows[id]
	if !ok {
		return PriceList{}, fmt.Errorf("price_list %q: %w", id, ErrNotFound)
	}
	return item, nil
}

func (s *PriceListStore) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.rows[id]
	delete(s.rows, id)
	return ok
}

// Cheapest returns at most limit pricelist values sorted by price, then by name.
func (s *PriceListStore) Cheapest(limit int) []PriceList {
	s.mu.RLock()
	out := make([]PriceList, 0, len(s.rows))
	for _, item := range s.rows {
		out = append(out, item)
	}
	s.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].PriceCents != out[j].PriceCents {
			return out[i].PriceCents < out[j].PriceCents
		}
		return out[i].Name < out[j].Name
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *PriceListStore) WithTag(tag string) []PriceList {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []PriceList
	for _, item := range s.rows {
		for _, t := range item.Tags {
			if strings.EqualFold(t, tag) {
				out = append(out, item)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Subscription is the stored form of a subscription.
type Subscription struct {
	ID        string
	Name      string
	PriceCents int64
	Tags      []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// SubscriptionStore keeps subscription values in memory behind a mutex.
type SubscriptionStore struct {
	mu   sync.RWMutex
	rows map[string]Subscription
	now  func() time.Time
}

func NewSubscriptionStore(now func() time.Time) *SubscriptionStore {
	return &SubscriptionStore{rows: make(map[string]Subscription), now: now}
}

func (s *SubscriptionStore) Put(ctx context.Context, item Subscription) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(item.Name) == "" {
		return fmt.Errorf("subscription: empty name for %q", item.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if existing, ok := s.rows[item.ID]; ok {
		item.CreatedAt = existing.CreatedAt
	} else {
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	s.rows[item.ID] = item
	return nil
}

func (s *SubscriptionStore) Get(id string) (Subscription, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.rows[id]
	if !ok {
		return Subscription{}, fmt.Errorf("subscription %q: %w", id, ErrNotFound)
	}
	return item, nil
}

func (s *SubscriptionStore) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.rows[id]
	delete(s.rows, id)
	return ok
}

// Cheapest returns at most limit subscription values sorted by price, then by name.
func (s *SubscriptionStore) Cheapest(limit int) []Subscription {
	s.mu.RLock()
	out := make([]Subscription, 0, len(s.rows))
	for _, item := range s.rows {
		out = append(out, item)
	}
	s.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].PriceCents != out[j].PriceCents {
			return out[i].PriceCents < out[j].PriceCents
		}
		return out[i].Name < out[j].Name
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *SubscriptionStore) WithTag(tag string) []Subscription {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Subscription
	for _, item := range s.rows {
		for _, t := range item.Tags {
			if strings.EqualFold(t, tag) {
				out = append(out, item)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// GiftCard is the stored form of a giftcard.
type GiftCard struct {
	ID        string
	Name      string
	PriceCents int64
	Tags      []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// GiftCardStore keeps giftcard values in memory behind a mutex.
type GiftCardStore struct {
	mu   sync.RWMutex
	rows map[string]GiftCard
	now  func() time.Time
}

func NewGiftCardStore(now func() time.Time) *GiftCardStore {
	return &GiftCardStore{rows: make(map[string]GiftCard), now: now}
}

func (s *GiftCardStore) Put(ctx context.Context, item GiftCard) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(item.Name) == "" {
		return fmt.Errorf("gift_card: empty name for %q", item.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if existing, ok := s.rows[item.ID]; ok {
		item.CreatedAt = existing.CreatedAt
	} else {
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	s.rows[item.ID] = item
	return nil
}

func (s *GiftCardStore) Get(id string) (GiftCard, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.rows[id]
	if !ok {
		return GiftCard{}, fmt.Errorf("gift_card %q: %w", id, ErrNotFound)
	}
	return item, nil
}

func (s *GiftCardStore) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.rows[id]
	delete(s.rows, id)
	return ok
}

// Cheapest returns at most limit giftcard values sorted by price, then by name.
func (s *GiftCardStore) Cheapest(limit int) []GiftCard {
	s.mu.RLock()
	out := make([]GiftCard, 0, len(s.rows))
	for _, item := range s.rows {
		out = append(out, item)
	}
	s.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].PriceCents != out[j].PriceCents {
			return out[i].PriceCents < out[j].PriceCents
		}
		return out[i].Name < out[j].Name
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *GiftCardStore) WithTag(tag string) []GiftCard {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []GiftCard
	for _, item := range s.rows {
		for _, t := range item.Tags {
			if strings.EqualFold(t, tag) {
				out = append(out, item)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
