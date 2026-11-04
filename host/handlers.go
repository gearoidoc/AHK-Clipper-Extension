package main

import (
	"encoding/json/v2"
	"errors"
	"fmt"
	"runtime"
)

const maxEcho = 1024

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type errorReply struct {
	OK    bool      `json:"ok"`
	Error errorBody `json:"error"`
}

func errorResponse(code, message string) errorReply {
	return errorReply{Error: errorBody{Code: code, Message: message}}
}

// handle answers one request. Only the fixed set of message types is
// accepted, and each request is decoded strictly: unknown or duplicate
// members, wrong types, invalid UTF-8 and trailing data are all rejected.
func handle(raw []byte) any {
	var envelope struct {
		Type string `json:"type"`
	}
	// The envelope only routes the message; the typed decode below validates it.
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return errorResponse(codeBadRequest, "the message is not a JSON object with a string \"type\"")
	}
	var handler func([]byte) (any, error)
	switch envelope.Type {
	case "ping":
		handler = handlePing
	case "listFiles":
		handler = handleListFiles
	case "createFile":
		handler = handleCreateFile
	case "save":
		handler = handleSave
	case "scan", "undo", "reload":
		return errorResponse(codeNotImplemented, fmt.Sprintf("%q is not implemented in host %s", envelope.Type, version))
	default:
		return errorResponse(codeUnknownType, fmt.Sprintf("unknown message type %q", envelope.Type))
	}
	reply, err := handler(raw)
	if err != nil {
		var he *hostError
		if errors.As(err, &he) {
			return errorResponse(he.code, he.message)
		}
		return errorResponse(codeIOError, err.Error())
	}
	return reply
}

func decodeStrict(raw []byte, v any) error {
	if err := json.Unmarshal(raw, v, json.RejectUnknownMembers(true)); err != nil {
		return fail(codeBadRequest, "%v", err)
	}
	return nil
}

type pingRequest struct {
	Type string `json:"type"`
	Echo string `json:"echo"`
}

type pingReply struct {
	OK      bool   `json:"ok"`
	Version string `json:"version"`
	Echo    string `json:"echo"`
	// Empty when AutoHotkey v2 isn't installed in a standard place.
	AhkPath string `json:"ahkPath"`
	OS      string `json:"os"`
}

func handlePing(raw []byte) (any, error) {
	var req pingRequest
	if err := decodeStrict(raw, &req); err != nil {
		return nil, err
	}
	if len(req.Echo) > maxEcho {
		return nil, fail(codeBadRequest, "echo is longer than %d bytes", maxEcho)
	}
	return pingReply{
		OK:      true,
		Version: version,
		Echo:    req.Echo,
		AhkPath: findAutoHotkey(),
		OS:      runtime.GOOS + "/" + runtime.GOARCH,
	}, nil
}
