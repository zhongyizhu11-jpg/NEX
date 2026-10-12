package main

/*
导入现有配置（#16）要读 gost v3 的 gost.yml。Agent 不加依赖，所以这里是一个只够用的
YAML 子集：块状的 map / list、标量（带不带引号）、行尾注释、`- key: value` 形式的列表项、
最简单的流式 `[a, b]` / `{}`。锚点、多文档、多行字符串之类都不支持 —— 读不懂就当
这份文件不认识，扫描结果里写「看不懂这份配置」，不会出错。
*/

import (
	"errors"
	"strings"
)

type yamlLine struct {
	indent int
	text   string
}

func yamlStripComment(line string) string {
	inSingle, inDouble := false, false
	for i, r := range line {
		switch r {
		case '\'':
			if !inDouble {
				inSingle = !inSingle
			}
		case '"':
			if !inSingle {
				inDouble = !inDouble
			}
		case '#':
			if !inSingle && !inDouble && (i == 0 || line[i-1] == ' ' || line[i-1] == '\t') {
				return line[:i]
			}
		}
	}
	return line
}

func yamlLines(content string) []yamlLine {
	var lines []yamlLine
	for _, raw := range strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n") {
		raw = strings.ReplaceAll(raw, "\t", "  ")
		stripped := strings.TrimRight(yamlStripComment(raw), " ")
		trimmed := strings.TrimLeft(stripped, " ")
		if trimmed == "" || trimmed == "---" || trimmed == "..." {
			continue
		}
		lines = append(lines, yamlLine{indent: len(stripped) - len(trimmed), text: trimmed})
	}
	return lines
}

// parseMiniYAML 把 YAML 子集解析成 map[string]any / []any / string。
func parseMiniYAML(content string) (any, error) {
	lines := yamlLines(content)
	if len(lines) == 0 {
		return map[string]any{}, nil
	}
	value, next, err := yamlParseBlock(lines, 0, lines[0].indent)
	if err != nil {
		return nil, err
	}
	if next != len(lines) {
		return nil, errors.New("yaml: unexpected indentation")
	}
	return value, nil
}

func yamlIsListItem(text string) bool {
	return text == "-" || strings.HasPrefix(text, "- ")
}

// yamlSplitKey 拆 `key: value`；不是这种形式返回 ok=false。
func yamlSplitKey(text string) (key, rest string, ok bool) {
	inSingle, inDouble := false, false
	for i, r := range text {
		switch r {
		case '\'':
			if !inDouble {
				inSingle = !inSingle
			}
		case '"':
			if !inSingle {
				inDouble = !inDouble
			}
		case ':':
			if inSingle || inDouble {
				continue
			}
			if i+1 == len(text) || text[i+1] == ' ' {
				key = yamlScalar(strings.TrimSpace(text[:i]))
				if key == "" {
					return "", "", false
				}
				return key, strings.TrimSpace(text[i+1:]), true
			}
		}
	}
	return "", "", false
}

func yamlParseBlock(lines []yamlLine, start, indent int) (any, int, error) {
	if start >= len(lines) {
		return nil, start, nil
	}
	if yamlIsListItem(lines[start].text) {
		return yamlParseList(lines, start, indent)
	}
	return yamlParseMap(lines, start, indent)
}

func yamlParseList(lines []yamlLine, start, indent int) (any, int, error) {
	var list []any
	i := start
	for i < len(lines) && lines[i].indent == indent && yamlIsListItem(lines[i].text) {
		rest := strings.TrimSpace(strings.TrimPrefix(lines[i].text, "-"))
		if rest == "" {
			// 内容在下一行、缩进更深。
			if i+1 < len(lines) && lines[i+1].indent > indent {
				value, next, err := yamlParseBlock(lines, i+1, lines[i+1].indent)
				if err != nil {
					return nil, i, err
				}
				list = append(list, value)
				i = next
				continue
			}
			list = append(list, nil)
			i++
			continue
		}
		if _, _, isKey := yamlSplitKey(rest); isKey && !strings.HasPrefix(rest, "[") && !strings.HasPrefix(rest, "{") {
			// `- key: value`：把它当成缩进在「-」后面的一个 map 的第一行。
			itemIndent := indent + (len(lines[i].text) - len(rest))
			sub := []yamlLine{{indent: itemIndent, text: rest}}
			j := i + 1
			for j < len(lines) && lines[j].indent > indent {
				sub = append(sub, lines[j])
				j++
			}
			value, next, err := yamlParseMap(sub, 0, itemIndent)
			if err != nil {
				return nil, i, err
			}
			if next != len(sub) {
				return nil, i, errors.New("yaml: bad list item")
			}
			list = append(list, value)
			i = j
			continue
		}
		list = append(list, yamlFlowValue(rest))
		i++
	}
	return list, i, nil
}

func yamlParseMap(lines []yamlLine, start, indent int) (any, int, error) {
	result := map[string]any{}
	i := start
	for i < len(lines) && lines[i].indent == indent && !yamlIsListItem(lines[i].text) {
		key, rest, ok := yamlSplitKey(lines[i].text)
		if !ok {
			return nil, i, errors.New("yaml: expected key: value")
		}
		i++
		if rest != "" {
			result[key] = yamlFlowValue(rest)
			continue
		}
		// 值在下面几行：缩进更深的块，或者和 key 同缩进的列表。
		if i < len(lines) && (lines[i].indent > indent || (lines[i].indent == indent && yamlIsListItem(lines[i].text))) {
			value, next, err := yamlParseBlock(lines, i, lines[i].indent)
			if err != nil {
				return nil, i, err
			}
			result[key] = value
			i = next
			continue
		}
		result[key] = nil
	}
	return result, i, nil
}

func yamlScalar(text string) string {
	text = strings.TrimSpace(text)
	if len(text) >= 2 && ((text[0] == '"' && text[len(text)-1] == '"') || (text[0] == '\'' && text[len(text)-1] == '\'')) {
		return text[1 : len(text)-1]
	}
	return text
}

func yamlFlowValue(text string) any {
	text = strings.TrimSpace(text)
	if strings.HasPrefix(text, "{") && strings.HasSuffix(text, "}") {
		table := map[string]any{}
		for _, part := range strings.Split(text[1:len(text)-1], ",") {
			if key, value, ok := yamlSplitKey(strings.TrimSpace(part)); ok {
				table[key] = yamlScalar(value)
			}
		}
		return table
	}
	if strings.HasPrefix(text, "[") && strings.HasSuffix(text, "]") {
		inner := strings.TrimSpace(text[1 : len(text)-1])
		list := []any{}
		if inner == "" {
			return list
		}
		for _, part := range strings.Split(inner, ",") {
			list = append(list, yamlScalar(part))
		}
		return list
	}
	return yamlScalar(text)
}
