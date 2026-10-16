package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

const nativeHostName = "com.rodon.takipci.device"
const firefoxExtensionID = "takipci-paneli@extension"

var chromiumExtensionIDPattern = regexp.MustCompile(`^[a-p]{32}$`)

type nativeHostManifest struct {
	Name             string   `json:"name"`
	Description      string   `json:"description"`
	Path             string   `json:"path"`
	Type             string   `json:"type"`
	AllowedOrigins   []string `json:"allowed_origins,omitempty"`
	AllowedExtensions []string `json:"allowed_extensions,omitempty"`
}

func installNativeHost(args []string) error {
	flags := flag.NewFlagSet("install", flag.ContinueOnError)
	chromeIDFlag := flags.String("chrome-id", "", "Chrome extension ID")
	edgeIDFlag := flags.String("edge-id", "", "Edge extension ID")
	if err := flags.Parse(args); err != nil {
		return err
	}

	chromeID, err := promptExtensionID("Chrome extension ID (leave blank to skip)", *chromeIDFlag)
	if err != nil {
		return err
	}
	edgeID, err := promptExtensionID("Edge extension ID (leave blank to skip)", *edgeIDFlag)
	if err != nil {
		return err
	}

	binaryPath, err := installBinary()
	if err != nil {
		return err
	}
	if err := registerNativeHost(binaryPath, chromeID, edgeID); err != nil {
		return err
	}

	fmt.Println("RODON device helper installed.")
	fmt.Println("The server receives only a locally hashed, stable device identifier.")
	fmt.Println("Free-trial history remains on the server if this helper is uninstalled.")
	return nil
}

func promptExtensionID(label, value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		fmt.Printf("%s: ", label)
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return "", err
		}
		value = strings.TrimSpace(line)
	}
	if value == "" {
		return "", nil
	}
	if !chromiumExtensionIDPattern.MatchString(value) {
		return "", fmt.Errorf("invalid extension ID %q; Chrome and Edge IDs must be 32 letters from a to p", value)
	}
	return value, nil
}

func installBinary() (string, error) {
	var targetDirectory string
	switch runtime.GOOS {
	case "windows":
		root := os.Getenv("LOCALAPPDATA")
		if root == "" {
			return "", errors.New("LOCALAPPDATA is not available")
		}
		targetDirectory = filepath.Join(root, "Rodon", "Device Companion")
	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		targetDirectory = filepath.Join(home, "Library", "Application Support", "Rodon", "Device Companion")
	case "linux":
		root := os.Getenv("XDG_DATA_HOME")
		if root == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return "", err
			}
			root = filepath.Join(home, ".local", "share")
		}
		targetDirectory = filepath.Join(root, "rodon", "device-companion")
	default:
		return "", errors.New("unsupported operating system")
	}

	if err := os.MkdirAll(targetDirectory, 0o755); err != nil {
		return "", err
	}
	filename := "rodon-device-host"
	if runtime.GOOS == "windows" {
		filename += ".exe"
	}
	targetPath := filepath.Join(targetDirectory, filename)
	sourcePath, err := os.Executable()
	if err != nil {
		return "", err
	}
	sourcePath, _ = filepath.Abs(sourcePath)
	targetPath, _ = filepath.Abs(targetPath)
	if filepath.Clean(sourcePath) == filepath.Clean(targetPath) {
		return targetPath, nil
	}

	source, err := os.Open(sourcePath)
	if err != nil {
		return "", err
	}
	defer source.Close()

	temporaryPath := targetPath + ".new"
	destination, err := os.OpenFile(temporaryPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return "", err
	}
	_, copyErr := io.Copy(destination, source)
	closeErr := destination.Close()
	if copyErr != nil {
		os.Remove(temporaryPath)
		return "", copyErr
	}
	if closeErr != nil {
		os.Remove(temporaryPath)
		return "", closeErr
	}
	if err := os.Chmod(temporaryPath, 0o755); err != nil {
		os.Remove(temporaryPath)
		return "", err
	}
	if runtime.GOOS == "windows" {
		if err := os.Remove(targetPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			os.Remove(temporaryPath)
			return "", err
		}
	}
	if err := os.Rename(temporaryPath, targetPath); err != nil {
		os.Remove(temporaryPath)
		return "", err
	}
	return targetPath, nil
}

func registerNativeHost(binaryPath, chromeID, edgeID string) error {
	chromeOrigin := ""
	edgeOrigin := ""
	if chromeID != "" {
		chromeOrigin = "chrome-extension://" + chromeID + "/"
	}
	if edgeID != "" {
		edgeOrigin = "chrome-extension://" + edgeID + "/"
	}

	switch runtime.GOOS {
	case "windows":
		return registerWindowsHost(binaryPath, chromeOrigin, edgeOrigin)
	case "darwin":
		return registerMacHost(binaryPath, chromeOrigin, edgeOrigin)
	case "linux":
		return registerLinuxHost(binaryPath, chromeOrigin, edgeOrigin)
	default:
		return errors.New("unsupported operating system")
	}
}

func registerLinuxHost(binaryPath, chromeOrigin, edgeOrigin string) error {
	configRoot, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	if chromeOrigin != "" {
		if _, err := writeChromiumManifest(filepath.Join(configRoot, "google-chrome", "NativeMessagingHosts"), binaryPath, chromeOrigin); err != nil {
			return err
		}
	}
	if edgeOrigin != "" {
		if _, err := writeChromiumManifest(filepath.Join(configRoot, "microsoft-edge", "NativeMessagingHosts"), binaryPath, edgeOrigin); err != nil {
			return err
		}
	}
	_, err = writeFirefoxManifest(filepath.Join(home, ".mozilla", "native-messaging-hosts"), binaryPath)
	return err
}

func registerMacHost(binaryPath, chromeOrigin, edgeOrigin string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	base := filepath.Join(home, "Library", "Application Support")
	if chromeOrigin != "" {
		if _, err := writeChromiumManifest(filepath.Join(base, "Google", "Chrome", "NativeMessagingHosts"), binaryPath, chromeOrigin); err != nil {
			return err
		}
	}
	if edgeOrigin != "" {
		if _, err := writeChromiumManifest(filepath.Join(base, "Microsoft Edge", "NativeMessagingHosts"), binaryPath, edgeOrigin); err != nil {
			return err
		}
	}
	_, err = writeFirefoxManifest(filepath.Join(base, "Mozilla", "NativeMessagingHosts"), binaryPath)
	return err
}

func registerWindowsHost(binaryPath, chromeOrigin, edgeOrigin string) error {
	root := os.Getenv("LOCALAPPDATA")
	manifestRoot := filepath.Join(root, "Rodon", "Native Messaging")
	if chromeOrigin != "" {
		manifestPath, err := writeChromiumManifest(filepath.Join(manifestRoot, "Chrome"), binaryPath, chromeOrigin)
		if err != nil {
			return err
		}
		if err := registerWindowsManifest(`HKCU\Software\Google\Chrome\NativeMessagingHosts\`+nativeHostName, manifestPath); err != nil {
			return err
		}
	}
	if edgeOrigin != "" {
		manifestPath, err := writeChromiumManifest(filepath.Join(manifestRoot, "Edge"), binaryPath, edgeOrigin)
		if err != nil {
			return err
		}
		if err := registerWindowsManifest(`HKCU\Software\Microsoft\Edge\NativeMessagingHosts\`+nativeHostName, manifestPath); err != nil {
			return err
		}
	}
	manifestPath, err := writeFirefoxManifest(filepath.Join(manifestRoot, "Firefox"), binaryPath)
	if err != nil {
		return err
	}
	return registerWindowsManifest(`HKCU\Software\Mozilla\NativeMessagingHosts\`+nativeHostName, manifestPath)
}

func writeChromiumManifest(directory, binaryPath, origin string) (string, error) {
	return writeManifest(directory, nativeHostManifest{
		Name:           nativeHostName,
		Description:    "RODON stable device identity helper",
		Path:           binaryPath,
		Type:           "stdio",
		AllowedOrigins: []string{origin},
	})
}

func writeFirefoxManifest(directory, binaryPath string) (string, error) {
	return writeManifest(directory, nativeHostManifest{
		Name:              nativeHostName,
		Description:       "RODON stable device identity helper",
		Path:              binaryPath,
		Type:              "stdio",
		AllowedExtensions: []string{firefoxExtensionID},
	})
}

func writeManifest(directory string, manifest nativeHostManifest) (string, error) {
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return "", err
	}
	manifestPath := filepath.Join(directory, nativeHostName+".json")
	payload, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(manifestPath, append(payload, '\n'), 0o644); err != nil {
		return "", err
	}
	return manifestPath, nil
}

func registerWindowsManifest(key, manifestPath string) error {
	command := exec.Command("reg.exe", "add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f")
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("could not register native host (%s): %w", strings.TrimSpace(string(output)), err)
	}
	return nil
}
