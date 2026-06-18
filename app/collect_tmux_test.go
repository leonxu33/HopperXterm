package main

import (
	"sort"
	"testing"
)

// collectTmuxIDs harvests every "tmuxId" string from a decoded workspace
// layout (a tree of maps/slices), skipping leaves without one and ignoring
// empty values and non-container inputs.
func TestCollectTmuxIDs(t *testing.T) {
	layout := map[string]interface{}{
		"kind": "split",
		"children": []interface{}{
			map[string]interface{}{"kind": "leaf", "sessionId": "s1", "tmuxId": "tokA"},
			map[string]interface{}{"kind": "leaf", "sessionId": "s2"}, // no tmuxId
			map[string]interface{}{
				"kind": "split",
				"children": []interface{}{
					map[string]interface{}{"kind": "leaf", "tmuxId": "tokB"},
				},
			},
		},
	}
	var got []string
	collectTmuxIDs(layout, &got)
	sort.Strings(got)
	if len(got) != 2 || got[0] != "tokA" || got[1] != "tokB" {
		t.Errorf("collectTmuxIDs = %v, want [tokA tokB]", got)
	}

	// Empty tmuxId is ignored; scalar / nil inputs are no-ops.
	var none []string
	collectTmuxIDs(map[string]interface{}{"tmuxId": ""}, &none)
	collectTmuxIDs("scalar", &none)
	collectTmuxIDs(nil, &none)
	if len(none) != 0 {
		t.Errorf("expected no ids, got %v", none)
	}
}
