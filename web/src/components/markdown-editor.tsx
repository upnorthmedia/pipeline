"use client";

import { useCallback, useEffect, useRef } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";

const extensions = [
  markdown({ base: markdownLanguage, codeLanguages: languages }),
  EditorView.lineWrapping,
];

interface MarkdownEditorProps {
  content: string;
  onChange?: (value: string) => void;
  onSave?: (value: string) => void;
  readOnly?: boolean;
  className?: string;
  height?: string;
  autoSaveMs?: number;
}

export function MarkdownEditor({
  content,
  onChange,
  onSave,
  readOnly = false,
  className,
  height = "500px",
  autoSaveMs = 1500,
}: MarkdownEditorProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestValueRef = useRef(content);
  const editorRef = useRef<ReactCodeMirrorRef>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleChange = useCallback(
    (value: string) => {
      latestValueRef.current = value;
      onChange?.(value);

      if (onSave && autoSaveMs > 0) {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          onSave(latestValueRef.current);
        }, autoSaveMs);
      }
    },
    [onChange, onSave, autoSaveMs]
  );

  return (
    <div className={className} data-testid="markdown-editor">
      <CodeMirror
        ref={editorRef}
        value={content}
        height={height}
        theme="dark"
        extensions={extensions}
        onChange={handleChange}
        readOnly={readOnly}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: !readOnly,
          bracketMatching: true,
        }}
      />
    </div>
  );
}
