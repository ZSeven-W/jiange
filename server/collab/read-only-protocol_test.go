package collab

import (
	"bytes"
	"testing"
)

func TestReadOnlyProtocolWire(t *testing.T) {
	welcome := EncodeWelcomeV3(7, 3, 3, []byte{1, 2, 3}, 2, true)
	if want := []byte{0x11, 7, 3, 1, 3, 3, 1, 2, 3, 2, 1}; !bytes.Equal(welcome, want) {
		t.Fatalf("welcome: %x", welcome)
	}
	decoded, err := DecodeServerMsg(welcome)
	if err != nil || !decoded.HasMode || !decoded.ReadOnly || decoded.HistoryEpoch != 2 || decoded.HeadSeq != 3 {
		t.Fatalf("welcome decode: %+v %v", decoded, err)
	}
	projection := EncodeProjection(4, 2, []byte{1, 2, 3})
	if want := []byte{0x16, 4, 2, 3, 1, 2, 3}; !bytes.Equal(projection, want) {
		t.Fatalf("projection: %x", projection)
	}
	decoded, err = DecodeServerMsg(projection)
	if err != nil || decoded.Type != MsgProjection || decoded.HeadSeq != 4 || decoded.HistoryEpoch != 2 || !bytes.Equal(decoded.State, []byte{1, 2, 3}) {
		t.Fatalf("projection decode: %+v %v", decoded, err)
	}
	if _, err := DecodeServerMsg([]byte{0x11, 7, 3, 2}); err == nil {
		t.Fatal("accepted invalid snapshot flag")
	}
}
