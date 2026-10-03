import { useCallback, useEffect, useRef, useState } from "react";

type SpeechAlternative = { transcript: string };
type SpeechResult = ArrayLike<SpeechAlternative> & { isFinal: boolean };
type SpeechResultEvent = { results: ArrayLike<SpeechResult> };
type SpeechErrorEvent = { error: string };

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;
type SpeechWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

function describeSpeechError(code: string): string {
  if (code === "not-allowed" || code === "service-not-allowed") {
    return "No se autorizó el micrófono. Revisá los permisos de este sitio.";
  }
  if (code === "no-speech") return "No alcancé a escuchar. Probá de nuevo cuando quieras.";
  if (code === "audio-capture") return "No encontré un micrófono disponible.";
  if (code === "network") return "La transcripción no está disponible en este momento.";
  return "No pude iniciar el dictado. Podés escribir tu idea en el cuadro.";
}

export function useSpeechRecognition(onTranscript: (text: string) => void) {
  const [isSupported, setIsSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  const prefixRef = useRef("");

  onTranscriptRef.current = onTranscript;

  useEffect(() => {
    const speechWindow = window as SpeechWindow;
    setIsSupported(Boolean(speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition));
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  const start = useCallback((existingText = "") => {
    const speechWindow = window as SpeechWindow;
    const SpeechRecognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError("Este navegador no ofrece dictado por voz. Podés escribir tu idea en el cuadro.");
      return;
    }

    recognitionRef.current?.abort();
    setError(null);
    prefixRef.current = existingText.trim();

    const recognition = new SpeechRecognition();
    recognition.lang = "es-AR";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      if (recognitionRef.current !== recognition) return;
      const spokenText = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? "")
        .filter(Boolean)
        .join(" ")
        .trim();
      const combined = [prefixRef.current, spokenText].filter(Boolean).join(" ").trim();
      onTranscriptRef.current(combined);
    };
    recognition.onerror = (event) => {
      if (recognitionRef.current === recognition) setError(describeSpeechError(event.error));
    };
    recognition.onend = () => {
      setIsListening(false);
      if (recognitionRef.current === recognition) recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    setIsListening(true);
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setIsListening(false);
      setError("No pude acceder al micrófono. Probá de nuevo o escribí tu idea.");
    }
  }, []);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const cancel = useCallback(() => {
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    setIsListening(false);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { isSupported, isListening, error, start, stop, cancel, clearError };
}