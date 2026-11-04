package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheckName(t *testing.T) {
	good := []string{"General.ahk", "Email replies.ahk", "a.b.ahk", "Upper.AHK", "été.ahk"}
	bad := []string{
		"", ".ahk", "General", "General.txt", "../General.ahk", `..\General.ahk`, "a/b.ahk", `a\b.ahk`,
		"C:General.ahk", "a*b.ahk", "a?.ahk", "a|b.ahk", "a\"b.ahk", "a<b.ahk", "a\x01.ahk",
		".hidden.ahk", " lead.ahk", "trail .ahk", "dot..ahk", "CON.ahk", "nul.ahk", "com1.ahk", "LPT9.x.ahk",
		strings.Repeat("a", maxNameLength) + ".ahk",
	}
	for _, name := range good {
		if err := checkName(name); err != nil {
			t.Errorf("checkName(%q) = %v, want ok", name, err)
		}
	}
	for _, name := range bad {
		if err := checkName(name); codeOf(err) != codeBadName {
			t.Errorf("checkName(%q) = %v, want %s", name, err, codeBadName)
		}
	}
}

func TestResolveFolder(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "file.ahk")
	os.WriteFile(file, nil, 0o644)
	for name, folder := range map[string]string{
		"empty":    "",
		"relative": "AHK",
		"missing":  filepath.Join(dir, "missing"),
		"a file":   file,
	} {
		if _, err := resolveFolder(folder); codeOf(err) != codeFolderMissing {
			t.Errorf("%s: expected %s, got %v", name, codeFolderMissing, err)
		}
	}
	got, err := resolveFolder(dir + string(filepath.Separator) + ".")
	if err != nil || !samePath(got, mustEval(t, dir)) {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestResolveFileStaysInsideTheFolder(t *testing.T) {
	root := t.TempDir()
	folder := filepath.Join(root, "AHK")
	os.Mkdir(folder, 0o755)
	folder = mustEval(t, folder)
	os.WriteFile(filepath.Join(folder, "General.ahk"), nil, 0o644)
	os.WriteFile(filepath.Join(root, "Outside.ahk"), nil, 0o644)
	os.Mkdir(filepath.Join(folder, "Dir.ahk"), 0o755)

	if path, err := resolveFile(folder, "General.ahk", true); err != nil || filepath.Dir(path) != folder {
		t.Fatalf("General.ahk: %q, %v", path, err)
	}
	if _, err := resolveFile(folder, "New.ahk", true); codeOf(err) != codeFileMissing {
		t.Fatalf("missing file: %v", err)
	}
	if path, err := resolveFile(folder, "New.ahk", false); err != nil || path != filepath.Join(folder, "New.ahk") {
		t.Fatalf("new file: %q, %v", path, err)
	}
	if _, err := resolveFile(folder, "Dir.ahk", true); codeOf(err) != codeBadName {
		t.Fatalf("directory: %v", err)
	}
	if err := os.Symlink(filepath.Join(root, "Outside.ahk"), filepath.Join(folder, "Link.ahk")); err != nil {
		t.Skip("symlinks unavailable:", err)
	}
	if _, err := resolveFile(folder, "Link.ahk", true); codeOf(err) != codePathOutside {
		t.Fatalf("symlink out of the folder: %v", err)
	}
}

func mustEval(t *testing.T, path string) string {
	t.Helper()
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return real
}
