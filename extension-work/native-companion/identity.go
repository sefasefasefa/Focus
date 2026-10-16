package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
)

var (
	windowsMachineGUID = regexp.MustCompile(`(?im)^\s*MachineGuid\s+REG_SZ\s+([^\r\n]+)\s*$`)
	macPlatformUUID    = regexp.MustCompile(`"IOPlatformUUID"\s*=\s*"([^"]+)"`)
)

func stableDeviceID() (string, error) {
	machineID, err := readMachineIdentity()
	if err != nil {
		return "", err
	}
	machineID = strings.ToLower(strings.TrimSpace(machineID))
	if len(machineID) < 8 {
		return "", errors.New("machine identifier is missing or too short")
	}

	sum := sha256.Sum256([]byte("rodon-stable-device-v1\x00" + runtime.GOOS + "\x00" + machineID))
	return "rdn1_" + hex.EncodeToString(sum[:]), nil
}

func readMachineIdentity() (string, error) {
	switch runtime.GOOS {
	case "windows":
		output, err := exec.Command(
			"reg.exe",
			"query",
			`HKLM\SOFTWARE\Microsoft\Cryptography`,
			"/v",
			"MachineGuid",
		).Output()
		if err != nil {
			return "", err
		}
		match := windowsMachineGUID.FindSubmatch(output)
		if len(match) != 2 {
			return "", errors.New("Windows MachineGuid was not found")
		}
		return string(match[1]), nil

	case "darwin":
		output, err := exec.Command(
			"/usr/sbin/ioreg",
			"-rd1",
			"-c",
			"IOPlatformExpertDevice",
		).Output()
		if err != nil {
			return "", err
		}
		match := macPlatformUUID.FindSubmatch(output)
		if len(match) != 2 {
			return "", errors.New("macOS IOPlatformUUID was not found")
		}
		return string(match[1]), nil

	case "linux":
		for _, path := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
			value, err := os.ReadFile(path)
			if err == nil && strings.TrimSpace(string(value)) != "" {
				return string(value), nil
			}
		}
		return "", errors.New("Linux machine-id was not found")

	default:
		return "", errors.New("unsupported operating system")
	}
}

func runtimePlatform() string {
	return runtime.GOOS + "/" + runtime.GOARCH
}
