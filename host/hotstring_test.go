package main

import (
	"encoding/json/v2"
	"os"
	"testing"
)

type fixture struct {
	About string `json:"about"`
	Lines []struct {
		Name    string         `json:"name"`
		Trigger string         `json:"trigger"`
		Text    string         `json:"text"`
		Options map[string]any `json:"options"`
		Line    string         `json:"line"`
	} `json:"lines"`
	Rejected []struct {
		Name string `json:"name"`
		Line string `json:"line"`
	} `json:"rejected"`
}

func loadFixture(t *testing.T) fixture {
	t.Helper()
	data, err := os.ReadFile("testdata/hotstrings.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestHostAcceptsEveryGeneratedLine(t *testing.T) {
	for _, row := range loadFixture(t).Lines {
		t.Run(row.Name, func(t *testing.T) {
			if err := checkHotstringLine(row.Line); err != nil {
				t.Fatalf("rejected %q: %v", row.Line, err)
			}
		})
	}
}

func TestHostRejectsAnythingElse(t *testing.T) {
	for _, row := range loadFixture(t).Rejected {
		t.Run(row.Name, func(t *testing.T) {
			if err := checkHotstringLine(row.Line); err == nil {
				t.Fatalf("accepted %q", row.Line)
			}
		})
	}
}

func TestExecutesByDefault(t *testing.T) {
	cases := map[string]bool{
		"":                                 false,
		"#Hotstring X":                     true,
		"#hotstring x":                     true,
		"  #Hotstring *0 X ; execute":      true,
		"#Hotstring X\n#Hotstring X0":      false,
		"#Hotstring X0\n#Hotstring X":      true,
		"#Hotstring EndChars xX":           false,
		"#Hotstring NoMouse":               false,
		"; #Hotstring X":                   false,
		"#Hotstring C":                     false,
		"#Hotstring SE":                    false,
		"::a::b\r\n#Hotstring X\r\n::c::d": true,
		"#Hotstring B0 ; X in a comment":   false,
	}
	for src, want := range cases {
		if got := executesByDefault(src); got != want {
			t.Errorf("executesByDefault(%q) = %v, want %v", src, got, want)
		}
	}
}
