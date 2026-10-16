package main

import (
	"encoding/binary"
	"errors"
	"io"
)

const maxNativeMessageSize = 64 * 1024

func readNativeMessage(reader io.Reader) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return nil, err
	}
	size := binary.LittleEndian.Uint32(header[:])
	if size == 0 || size > maxNativeMessageSize {
		return nil, errors.New("native messaging payload size is invalid")
	}
	payload := make([]byte, int(size))
	if _, err := io.ReadFull(reader, payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func writeNativeMessage(writer io.Writer, payload []byte) error {
	if len(payload) == 0 || len(payload) > maxNativeMessageSize {
		return errors.New("native messaging response size is invalid")
	}
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], uint32(len(payload)))
	if _, err := writer.Write(header[:]); err != nil {
		return err
	}
	_, err := writer.Write(payload)
	return err
}
