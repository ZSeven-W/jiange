package api

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"
)

// flowchartReferencesImage reports whether a flowchart block (props fc.n.<id>
// holding node JSON) contains an image node showing the given file.
func flowchartReferencesImage(props map[string]string, fileID string) bool {
	want, err := strconv.ParseInt(fileID, 10, 64)
	if err != nil || want <= 0 {
		return false
	}
	for key, value := range props {
		if !strings.HasPrefix(key, "fc.n.") || value == "" {
			continue
		}
		var node struct {
			Shape  string  `json:"shape"`
			FileID float64 `json:"fileId"`
		}
		if json.Unmarshal([]byte(value), &node) == nil && node.Shape == "image" && int64(node.FileID) == want && node.FileID == float64(int64(node.FileID)) {
			return true
		}
	}
	return false
}

// flowchartImageNode is an image node (prop key + file ID) inside a flowchart block.
type flowchartImageNode struct {
	Key    string
	FileID int64
}

// flowchartImageNodes lists image nodes with a canonical positive file ID, in key order.
func flowchartImageNodes(props map[string]string) []flowchartImageNode {
	var out []flowchartImageNode
	for key, value := range props {
		if !strings.HasPrefix(key, "fc.n.") || value == "" {
			continue
		}
		var node struct {
			Shape  string  `json:"shape"`
			FileID float64 `json:"fileId"`
		}
		if json.Unmarshal([]byte(value), &node) != nil || node.Shape != "image" || node.FileID <= 0 || node.FileID != float64(int64(node.FileID)) {
			continue
		}
		out = append(out, flowchartImageNode{Key: key, FileID: int64(node.FileID)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}

// rewriteFlowchartImage returns the node JSON with fileId replaced.
func rewriteFlowchartImage(value string, fileID int64) (string, error) {
	var node map[string]any
	if err := json.Unmarshal([]byte(value), &node); err != nil {
		return "", err
	}
	node["fileId"] = fileID
	b, err := json.Marshal(node)
	return string(b), err
}
