package pane

// State is the connection lifecycle for a single pane.
// Suspect and Disconnected drive the tab indicator.
type State string

const (
	StateConnecting   State = "Connecting"
	StateConnected    State = "Connected"
	StateSuspect      State = "Suspect"
	StateDisconnected State = "Disconnected"
)
