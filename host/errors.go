package main

import "fmt"

// Error codes; extension/src/protocol.ts mirrors this list.
const (
	codeBadRequest      = "bad_request"
	codeUnknownType     = "unknown_type"
	codeNotImplemented  = "not_implemented"
	codeForbiddenOrigin = "forbidden_origin"
	codeTooLarge        = "too_large"
	codeFolderMissing   = "folder_missing"
	codeFileMissing     = "file_missing"
	codeFileExists      = "file_exists"
	codeBadName         = "bad_name"
	codePathOutside     = "path_outside"
	codeAhkMissing      = "ahk_missing"
	codeAhkInvalid      = "ahk_invalid"
	codeReloadFailed    = "reload_failed"
	codeEncoding        = "encoding"
	codeFileBusy        = "file_busy"
	codeLocked          = "locked"
	codeBadLine         = "bad_line"
	codeHotstringX      = "hotstring_x"
	codeDuplicate       = "duplicate"
	codeFileChanged     = "file_changed"
	codeCodeBlock       = "code_block"
	codeIOError         = "io_error"
)

// hostError is a failure with a code the extension understands and a
// message written for the person using it.
type hostError struct {
	code    string
	message string
}

func (e *hostError) Error() string { return e.message }

func fail(code, format string, args ...any) *hostError {
	return &hostError{code: code, message: fmt.Sprintf(format, args...)}
}
