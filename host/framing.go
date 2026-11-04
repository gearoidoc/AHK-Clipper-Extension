package main

import (
	"encoding/binary"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
)

const (
	// Chrome accepts up to 64 MiB towards a host, but no request needs more
	// than a hotstring and a file name.
	maxInbound = 1 << 20
	// Chrome rejects messages from a host larger than 1 MB.
	maxOutbound = 1_000_000
)

// readMessage reads one message: a 32-bit length in native byte order
// (little-endian on every platform Chrome supports on Windows) followed by
// that many bytes of UTF-8 JSON. It returns io.EOF only on a clean close.
func readMessage(r io.Reader) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, errors.New("truncated length prefix")
		}
		return nil, err
	}
	n := binary.LittleEndian.Uint32(header[:])
	if n > maxInbound {
		return nil, fmt.Errorf("message of %d bytes exceeds the %d-byte limit", n, maxInbound)
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, fmt.Errorf("truncated message: expected %d bytes", n)
	}
	return body, nil
}

// writeMessage encodes v as JSON and writes it with its length prefix in a
// single Write.
func writeMessage(w io.Writer, v any) error {
	body, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(body) > maxOutbound {
		if body, err = json.Marshal(errorResponse(codeTooLarge, "the response exceeds Chrome's 1 MB limit")); err != nil {
			return err
		}
	}
	msg := binary.LittleEndian.AppendUint32(make([]byte, 0, 4+len(body)), uint32(len(body)))
	_, err = w.Write(append(msg, body...))
	return err
}
