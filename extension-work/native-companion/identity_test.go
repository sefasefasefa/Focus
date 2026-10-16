package main

import (
	"net"
	"reflect"
	"testing"
)

func TestStableMACAddressesFromInterfaces(t *testing.T) {
	interfaces := []net.Interface{
		{Name: "wifi", HardwareAddr: mustParseMAC(t, "a8:bb:cc:dd:ee:ff")},
		{Name: "ethernet", HardwareAddr: mustParseMAC(t, "00:11:22:33:44:55")},
		{Name: "duplicate", HardwareAddr: mustParseMAC(t, "00:11:22:33:44:55")},
		{Name: "loopback", Flags: net.FlagLoopback, HardwareAddr: mustParseMAC(t, "00:aa:bb:cc:dd:ee")},
		{Name: "randomized", HardwareAddr: mustParseMAC(t, "02:11:22:33:44:55")},
		{Name: "multicast", HardwareAddr: mustParseMAC(t, "01:11:22:33:44:55")},
		{Name: "short", HardwareAddr: net.HardwareAddr{0, 0, 0}},
	}

	got := stableMACAddressesFromInterfaces(interfaces)
	want := []string{"00:11:22:33:44:55", "a8:bb:cc:dd:ee:ff"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("stableMACAddressesFromInterfaces() = %v, want %v", got, want)
	}
}

func mustParseMAC(t *testing.T, value string) net.HardwareAddr {
	t.Helper()
	address, err := net.ParseMAC(value)
	if err != nil {
		t.Fatalf("ParseMAC(%q): %v", value, err)
	}
	return address
}
