import { useCallback, useRef, useState } from "react";
import { MessageType } from "../types/messages";

interface MicButtonProps {
  send: (type: string, data?: Record<string, unknown>) => void;
  disabled?: boolean;
  mode: "transcribe" | "send";
}

export default function MicButton({ send, disabled, mode }: MicButtonProps) {
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        console.log("[Mic] Chunks:", chunksRef.current.length, "Blob size:", blob.size, "bytes");

        if (blob.size < 100) {
          console.warn("[Mic] Audio blob too small, skipping");
          return;
        }

        // Use FileReader for bulletproof base64 encoding
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(",")[1];
          console.log("[Mic] Base64 length:", base64.length, "chars, first 40:", base64.slice(0, 40));
          send(MessageType.AUDIO_INPUT, {
            audio: base64,
            format: "webm",
            autoSend: mode === "send",
          });
        };
        reader.readAsDataURL(blob);
      };

      recorder.start();
      recorderRef.current = recorder;
      streamRef.current = stream;
      setRecording(true);
    } catch (err) {
      console.error("[Mic] Failed to start recording:", err);
    }
  }, [send, mode]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
      recorderRef.current = null;
    }
    setRecording(false);
  }, []);

  const toggle = useCallback(() => {
    if (recording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [recording, startRecording, stopRecording]);

  const isTranscribe = mode === "transcribe";
  const activeColor = isTranscribe ? "bg-blue-600" : "bg-red-600";
  const idleColor = "bg-gray-700 hover:bg-gray-600";
  const title = isTranscribe
    ? recording ? "Click to stop (transcribe to input)" : "Click to transcribe to input"
    : recording ? "Click to stop (record & send)" : "Click to record & send";

  return (
    <button
      onClick={toggle}
      disabled={disabled}
      className={`flex items-center justify-center w-9 h-9 rounded-full transition-colors ${
        recording ? `${activeColor} animate-pulse` : idleColor
      } disabled:opacity-40 disabled:cursor-not-allowed`}
      title={title}
    >
      {recording ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          className="w-4 h-4 text-white"
        >
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      ) : isTranscribe ? (
        /* Pencil icon */
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 text-white"
        >
          <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          <path d="m15 5 4 4" />
        </svg>
      ) : (
        /* Microphone icon */
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 text-white"
        >
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0" />
          <line x1="12" y1="18" x2="12" y2="22" />
          <line x1="8" y1="22" x2="16" y2="22" />
        </svg>
      )}
    </button>
  );
}
