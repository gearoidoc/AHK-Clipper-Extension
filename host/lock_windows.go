//go:build windows

package main

import (
	"errors"
	"os"
	"syscall"
)

const errSharingViolation syscall.Errno = 32

// tryLock opens the lock file with no sharing, which only one process can
// do at a time. Windows closes the handle when a process ends, however it
// ends, so a crashed host never leaves the folder locked.
func tryLock(path string) (unlock func(), busy bool, err error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, false, err
	}
	h, err := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_ALWAYS, syscall.FILE_ATTRIBUTE_HIDDEN, 0)
	// Another host has it open, or is just deleting it.
	if errors.Is(err, errSharingViolation) || errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
		return nil, true, nil
	}
	if err != nil {
		return nil, false, err
	}
	return func() {
		syscall.CloseHandle(h)
		// Fails harmlessly when the next host already has it open.
		os.Remove(path)
	}, false, nil
}
