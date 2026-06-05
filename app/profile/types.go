package profile

// SessionType identifies which transport a session uses. The set matches the
// PROTOCOLS catalogue in the design bundle (hopperterm-core.jsx).
type SessionType string

const (
	SessionSSH    SessionType = "ssh"
	SessionFTP    SessionType = "ftp"
	SessionSFTP   SessionType = "sftp"
	SessionShell  SessionType = "shell"
	SessionWSL    SessionType = "wsl"
	SessionAWS    SessionType = "aws"
	SessionAWSEC2 SessionType = "awsec2"
)

// Session is a saved connection target. One Go struct holds every protocol's
// fields; only the ones relevant to Type are populated. Credentials (passwords,
// key passphrases) live in the OS keychain, not in this struct.
type Session struct {
	ID      string      `json:"id"`
	Type    SessionType `json:"type"`
	Label   string      `json:"label"`
	GroupID string      `json:"groupId,omitempty"` // empty = root level

	// SSH / FTP / SFTP / AWS EC2
	Host string `json:"host,omitempty"`
	User string `json:"user,omitempty"`
	Port int    `json:"port,omitempty"`

	// WSL
	Distro string `json:"distro,omitempty"`

	// AWS S3
	Bucket string `json:"bucket,omitempty"` // stored without the s3:// prefix

	// AWS EC2 — extra
	InstanceID string `json:"instanceId,omitempty"`
	Region     string `json:"region,omitempty"`
	PemFile    string `json:"pemFile,omitempty"`

	// AWS named profile (S3 + EC2). Selects a section in
	// ~/.aws/credentials / ~/.aws/config via the SDK's shared-config
	// loader. Empty falls back to the SDK default chain (the "default"
	// profile, env vars, or an instance role). Secrets are never stored
	// here — they live in the AWS credentials file, managed by
	// `aws configure`.
	Profile string `json:"awsProfile,omitempty"`

	// Multi-line shell snippet to run after the connection opens.
	StartupCmds string `json:"startupCmds,omitempty"`
}

// Group is a sidebar bucket. Sessions reference it by ID via Session.GroupID.
// Sessions with GroupID == "" render at the sidebar root.
type Group struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color,omitempty"` // hex e.g. "#7df0c4"; empty = inherit accent
}

// Snapshot is the wire format returned to the frontend. Order in each slice is
// authoritative — Groups in render order; Sessions in render order within
// their bucket (root or a specific group).
type Snapshot struct {
	Groups   []Group   `json:"groups"`
	Sessions []Session `json:"sessions"`
}
