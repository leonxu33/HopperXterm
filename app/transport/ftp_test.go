package transport

import (
	"strings"
	"testing"
)

func TestDialFTP_HostRequired(t *testing.T) {
	if _, err := DialFTP(FTPDialConfig{}); err == nil {
		t.Error("DialFTP without a host should error")
	}
}

func TestFTP_NotConnectedGuards(t *testing.T) {
	f := &FTP{} // c == nil
	if _, err := f.Cwd(); err == nil {
		t.Error("Cwd")
	}
	if _, err := f.List("/"); err == nil {
		t.Error("List")
	}
	if err := f.Mkdir("/x", false); err == nil {
		t.Error("Mkdir")
	}
	if err := f.Remove("/x"); err == nil {
		t.Error("Remove")
	}
	if err := f.RemoveAll("/x"); err == nil {
		t.Error("RemoveAll")
	}
	if err := f.Rename("/a", "/b"); err == nil {
		t.Error("Rename")
	}
	if err := f.Create("/x"); err == nil {
		t.Error("Create")
	}
	if _, err := f.Download("/r", "/l", nil, nil); err == nil {
		t.Error("Download")
	}
	if _, err := f.Upload("/l", "/r", nil, nil); err == nil {
		t.Error("Upload")
	}
}

func TestFTP_CloseNilIsNoOp(t *testing.T) {
	f := &FTP{}
	if err := f.Close(); err != nil {
		t.Errorf("Close on nil conn: %v", err)
	}
}

func TestFTP_DirTransfersUnsupported(t *testing.T) {
	f := &FTP{}
	if _, err := f.UploadDir("/a", "/b", nil, nil); err == nil || !strings.Contains(err.Error(), "not yet supported") {
		t.Errorf("UploadDir should report unsupported, got %v", err)
	}
	if _, err := f.DownloadDir("/a", "/b", nil, nil); err == nil || !strings.Contains(err.Error(), "not yet supported") {
		t.Errorf("DownloadDir should report unsupported, got %v", err)
	}
}
