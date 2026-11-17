import { useEffect, useRef, useState } from 'react';

type RecognitionResult = { isFinal: boolean; 0?: { transcript: string } };
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> };

interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

export function useSpeechDictation(onTranscript: (text: string) => void) {
  const browser = typeof window === 'undefined' ? undefined : window as SpeechWindow;
  const Recognition = browser?.SpeechRecognition ?? browser?.webkitSpeechRecognition;
  const active = useRef<Recognition | null>(null);
  const [isListening, setListening] = useState(false);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!Recognition || !navigator.permissions?.query) return;
    let cancelled = false;
    let permission: PermissionStatus | undefined;
    const updatePermission = () => setDenied(permission?.state === 'denied');
    void navigator.permissions.query({ name: 'microphone' as PermissionName }).then(status => {
      if (cancelled) return;
      permission = status;
      updatePermission();
      status.addEventListener('change', updatePermission);
    }).catch(() => {
      // Some browsers only expose permission results through recognition events.
    });
    return () => {
      cancelled = true;
      permission?.removeEventListener('change', updatePermission);
    };
  }, [Recognition]);

  useEffect(() => () => {
    const recognition = active.current;
    active.current = null;
    recognition?.abort();
  }, []);

  function start() {
    if (!Recognition || denied || active.current) return;
    setError('');
    try {
      const recognition = new Recognition();
      recognition.lang = document.documentElement.lang || 'en';
      recognition.continuous = true;
      recognition.interimResults = false;

      const finish = () => {
        if (active.current !== recognition) return;
        active.current = null;
        setListening(false);
      };
      recognition.onend = finish;
      recognition.onerror = event => {
        if (active.current !== recognition) return;
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') setDenied(true);
        else if (event.error !== 'aborted') setError('Dictation stopped. You can keep typing or try again.');
        finish();
      };
      recognition.onresult = event => {
        if (active.current !== recognition) return;
        const phrases: string[] = [];
        for (let index = event.resultIndex; index < event.results.length; index++) {
          const result = event.results[index];
          const transcript = result.isFinal ? result[0]?.transcript.trim() : undefined;
          if (transcript) phrases.push(transcript);
        }
        if (phrases.length) onTranscript(phrases.join(' '));
      };

      active.current = recognition;
      setListening(true);
      recognition.start();
    } catch (cause) {
      active.current = null;
      setListening(false);
      if (cause instanceof DOMException && cause.name === 'NotAllowedError') setDenied(true);
      else setError('Couldn’t start dictation. You can keep typing or try again.');
    }
  }

  return {
    isListening, error, start,
    stop: () => active.current?.stop(),
    unavailableReason: !Recognition ? 'Voice dictation is unavailable in this browser.'
      : denied ? 'Microphone access is blocked. You can continue typing.' : '',
  };
}
