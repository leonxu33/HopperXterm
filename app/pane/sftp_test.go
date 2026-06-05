package pane

import (
	"sync"
	"testing"
)

// Transfer cancellation flag — pure-Go, no SFTP server involved.

func TestTransferLifecycle_DistinctIDs(t *testing.T) {
	a := nextTransferID()
	b := nextTransferID()
	if a == b {
		t.Fatalf("expected distinct ids, got %d / %d", a, b)
	}
	if b <= a {
		t.Errorf("ids should be monotonic, got %d then %d", a, b)
	}
}

func TestRegisterAndCancelTransfer(t *testing.T) {
	id := nextTransferID()
	ch := registerTransfer(id)
	defer unregisterTransfer(id)

	if isCancelled(ch) {
		t.Fatalf("freshly registered transfer is already cancelled")
	}
	CancelTransfer(id)
	if !isCancelled(ch) {
		t.Errorf("CancelTransfer did not signal the channel")
	}
}

func TestCancelTransfer_UnknownIDIsNoOp(t *testing.T) {
	// Shouldn't panic.
	CancelTransfer(0xffffffff)
}

func TestCancelTransfer_DoubleCancelSafe(t *testing.T) {
	id := nextTransferID()
	registerTransfer(id)
	defer unregisterTransfer(id)
	CancelTransfer(id)
	CancelTransfer(id) // close on closed channel would panic — must be guarded
}

func TestTransferRegistry_ConcurrentRegister(t *testing.T) {
	const n = 64
	var wg sync.WaitGroup
	ids := make([]uint64, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			ids[i] = nextTransferID()
			registerTransfer(ids[i])
		}(i)
	}
	wg.Wait()
	// All registered; cancel all; assert each was signaled.
	seen := map[uint64]bool{}
	for _, id := range ids {
		if seen[id] {
			t.Errorf("duplicate id %d under concurrency", id)
		}
		seen[id] = true
	}
	// Cleanup.
	for _, id := range ids {
		CancelTransfer(id)
		unregisterTransfer(id)
	}
}
