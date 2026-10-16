package main

import (
	"encoding/json"
	"fmt"
	"os"
)

const companionVersion = "1.1.0"

type nativeRequest struct {
	Action string `json:"action"`
}

type nativeResponse struct {
	OK           bool     `json:"ok"`
	DeviceID     string   `json:"deviceId,omitempty"`
	MACAddresses []string `json:"macAddresses"`
	Platform     string   `json:"platform,omitempty"`
	Version      string   `json:"version,omitempty"`
	Error        string   `json:"error,omitempty"`
}

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--install":
			if err := installNativeHost(os.Args[2:]); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			return
		case "--version":
			fmt.Println(companionVersion)
			return
		case "--help", "-h":
			fmt.Println("Run --install to register the device helper with Chrome, Edge, and Firefox.")
			return
		}
	}

	request, err := readNativeRequest()
	if err != nil {
		writeNativeResponse(nativeResponse{OK: false, Error: "Invalid native messaging request."})
		return
	}
	if request.Action != "getDeviceId" {
		writeNativeResponse(nativeResponse{OK: false, Error: "Unsupported native messaging action."})
		return
	}

	deviceID, err := stableDeviceID()
	if err != nil {
		writeNativeResponse(nativeResponse{OK: false, Error: "Could not read a stable device identifier."})
		return
	}

	writeNativeResponse(nativeResponse{
		OK:           true,
		DeviceID:     deviceID,
		MACAddresses: stableMACAddresses(),
		Platform:     runtimePlatform(),
		Version:      companionVersion,
	})
}

func readNativeRequest() (nativeRequest, error) {
	var request nativeRequest
	payload, err := readNativeMessage(os.Stdin)
	if err != nil {
		return request, err
	}
	if err := json.Unmarshal(payload, &request); err != nil {
		return request, err
	}
	return request, nil
}

func writeNativeResponse(response nativeResponse) {
	payload, err := json.Marshal(response)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Could not encode native response.")
		return
	}
	if err := writeNativeMessage(os.Stdout, payload); err != nil {
		fmt.Fprintln(os.Stderr, "Could not write native response.")
	}
}
