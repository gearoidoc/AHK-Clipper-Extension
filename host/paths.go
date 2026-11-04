package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

const maxNameLength = 100

var (
	// Characters Windows doesn't allow in file names, plus control characters.
	badNameChars = regexp.MustCompile(`[<>:"/\\|?*\x00-\x1f]`)
	// Windows device names, reserved even with an extension (con.ahk, con.x.ahk).
	reservedName = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[0-9]|lpt[0-9])$`)
)

// resolveFolder checks the configured AHK folder and returns its canonical
// path. On Windows EvalSymlinks also corrects the case of every element,
// which /restart needs to find the running script by its window title.
func resolveFolder(folder string) (string, error) {
	if folder == "" {
		return "", fail(codeFolderMissing, "Choose your AHK folder in Settings first.")
	}
	if !filepath.IsAbs(folder) {
		return "", fail(codeFolderMissing, `The AHK folder must be a full path, such as C:\Users\you\Hotstrings.`)
	}
	real, err := filepath.EvalSymlinks(folder)
	if err != nil {
		return "", fail(codeFolderMissing, "The AHK folder %s doesn't exist.", folder)
	}
	if info, err := os.Stat(real); err != nil || !info.IsDir() {
		return "", fail(codeFolderMissing, "%s isn't a folder.", folder)
	}
	return filepath.Clean(real), nil
}

// checkName accepts a plain .ahk file name that is valid on Windows.
func checkName(name string) error {
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	switch {
	case !strings.EqualFold(ext, ".ahk") || stem == "":
		return fail(codeBadName, "%q isn't an .ahk file name.", name)
	case len(name) > maxNameLength:
		return fail(codeBadName, "File names can be at most %d characters.", maxNameLength)
	case badNameChars.MatchString(name):
		return fail(codeBadName, `File names can't contain \ / : * ? " < > | or control characters.`)
	case strings.HasPrefix(name, ".") || strings.HasPrefix(name, " ") || strings.HasSuffix(stem, " ") || strings.HasSuffix(stem, "."):
		return fail(codeBadName, "File names can't start with a dot or a space, or end with one before .ahk.")
	case reservedName.MatchString(strings.SplitN(stem, ".", 2)[0]):
		return fail(codeBadName, "%q is a reserved name on Windows.", name)
	}
	return nil
}

// resolveFile returns the path of the named file directly inside folder,
// following a symlink or junction only if it stays in the folder. With
// mustExist the file has to be there already.
func resolveFile(folder, name string, mustExist bool) (string, error) {
	if err := checkName(name); err != nil {
		return "", err
	}
	path := filepath.Join(folder, name)
	if _, err := os.Lstat(path); errors.Is(err, fs.ErrNotExist) {
		if mustExist {
			return "", fail(codeFileMissing, "%s isn't in the AHK folder any more.", name)
		}
		return path, nil
	} else if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	if !samePath(filepath.Dir(real), folder) {
		return "", fail(codePathOutside, "%s points outside the AHK folder.", name)
	}
	if info, err := os.Stat(real); err != nil || !info.Mode().IsRegular() {
		return "", fail(codeBadName, "%s isn't a regular file.", name)
	}
	return real, nil
}

func samePath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}
