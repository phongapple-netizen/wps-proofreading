package main

import (
	"encoding/binary"
	"unicode/utf16"
)

const runKeyPath = `Software\Microsoft\Windows\CurrentVersion\Run`
const runValueName = "WPSProofreading"

// Keep the registry type and bytes intact, including empty values and
// REG_EXPAND_SZ environment references, so rollback restores the exact value.
// A string holds raw bytes and keeps snapshots comparable.
type runValue struct {
	present bool
	kind    uint32
	value   string
}

func stringRunValue(command string) runValue {
	units := append(utf16.Encode([]rune(command)), 0)
	data := make([]byte, 2*len(units))
	for i, unit := range units {
		binary.LittleEndian.PutUint16(data[2*i:], unit)
	}
	return runValue{present: true, kind: 1 /* REG_SZ */, value: string(data)}
}
