import { useEffect, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle, MessageSquare, Send, Trash2 } from "lucide-react";
import { useSendPrismaChat } from "@workspace/api-client-react";
import { useAuthenticatedUser } from "@/components/auth-gate";
import "./prisma-chat.css";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

const MAX_LOCAL_MESSAGES = 200;
const MAX_REQUEST_MESSAGES = 16;

function storageKeyFor(userId: string | undefined): string {
  return `corex:prisma:history:v1:${userId ?? "unavailable"}`;
}

function loadHistory(storageKey: string): ChatMessage[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((message): message is ChatMessage =>
        Boolean(
          message &&
          typeof message === "object" &&
          (message.role === "user" || message.role === "assistant") &&
          typeof message.content === "string" &&
          typeof message.id === "string",
        ),
      )
      .slice(-MAX_LOCAL_MESSAGES);
  } catch {
    return [];
  }
}

function messageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function apiError(error: unknown): string {
  if (typeof error === "object" && error && "data" in error) {
    const data = (error as { data?: { error?: string } }).data;
    if (data?.error) return data.error;
  }
  return "No se pudo enviar el mensaje. Revisá la conexión e intentá de nuevo.";
}

export function PrismaChat({ onBack }: { onBack: () => void }) {
  const { user } = useAuthenticatedUser();
  const storageKey = storageKeyFor(user?.id);
  const [ownerKey, setOwnerKey] = useState(storageKey);
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadHistory(storageKey));
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const endOfMessagesRef = useRef<HTMLDivElement>(null);
  const mutation = useSendPrismaChat();
  const ownerChanged = ownerKey !== storageKey;

  useEffect(() => {
    if (!ownerChanged) return;
    setMessages(loadHistory(storageKey));
    setOwnerKey(storageKey);
    setError(null);
  }, [ownerChanged, storageKey]);

  useEffect(() => {
    if (ownerChanged) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(messages.slice(-MAX_LOCAL_MESSAGES)));
    } catch {
      // Keep the chat usable when browser storage is unavailable or full.
    }
  }, [messages, ownerChanged, storageKey]);

  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, mutation.isPending]);

  const send = () => {
    const content = draft.trim();
    if (!content || mutation.isPending || ownerChanged) return;

    const userMessage: ChatMessage = { id: messageId(), role: "user", content };
    const conversation = [...messages, userMessage];
    const recentMessages = conversation.slice(-MAX_REQUEST_MESSAGES);
    let firstIncluded = recentMessages.length - 1;
    let totalCharacters = recentMessages[firstIncluded].content.length;
    while (
      firstIncluded > 0 &&
      totalCharacters + recentMessages[firstIncluded - 1].content.length <= 24_000
    ) {
      firstIncluded -= 1;
      totalCharacters += recentMessages[firstIncluded].content.length;
    }
    const requestMessages = recentMessages
      .slice(firstIncluded)
      .map(({ role, content: messageContent }) => ({ role, content: messageContent }));
    setMessages(conversation);
    setDraft("");
    setError(null);

    mutation.mutate(
      { data: { messages: requestMessages } },
      {
        onSuccess: (response) => {
          setMessages((current) => [
            ...current,
            { id: messageId(), role: "assistant", content: response.message },
          ]);
        },
        onError: (sendError) => setError(apiError(sendError)),
      },
    );
  };

  const clearHistory = () => {
    if (!window.confirm("¿Borrar el historial de Prisma guardado en este navegador?")) return;
    setMessages([]);
    setDraft("");
    setError(null);
  };

  const visibleMessages = messages.slice(-MAX_LOCAL_MESSAGES);

  return (
    <main className="prisma-chat">
      <header className="prisma-chat__header">
        <button type="button" className="prisma-chat__back" onClick={onBack}>
          <ArrowLeft size={17} /> <span>Volver a CoreX</span>
        </button>
        <div className="prisma-chat__title">
          <span className="prisma-chat__icon"><MessageSquare size={17} /></span>
          <div>
            <h1>Prisma</h1>
            <p>Conversación a través de Router IA</p>
          </div>
        </div>
        <button
          type="button"
          className="prisma-chat__clear"
          onClick={clearHistory}
          disabled={messages.length === 0 || mutation.isPending}
        >
          <Trash2 size={15} /> <span>Borrar historial</span>
        </button>
      </header>

      <section className="prisma-chat__conversation" aria-label="Conversación con Prisma" aria-live="polite">
        {ownerChanged ? (
          <p className="prisma-chat__storage-status">Cargando el historial de esta cuenta…</p>
        ) : visibleMessages.length === 0 ? (
          <div className="prisma-chat__welcome">
            <div className="prisma-chat__welcome-icon"><MessageSquare size={23} /></div>
            <p className="prisma-chat__eyebrow">MÓDULO OPCIONAL</p>
            <h2>¿Qué querés conversar?</h2>
            <p className="prisma-chat__welcome-copy">
              Prisma envía tus mensajes a través de Router IA. El historial se guarda solo en este navegador.
            </p>
            <div className="prisma-chat__suggestions">
              {[
                "Ayudame a ordenar una idea",
                "Resumí un texto que voy a pegar",
                "Proponé próximos pasos para un proyecto",
              ].map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => setDraft(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="prisma-chat__messages">
            {visibleMessages.map((message) => (
              <article
                key={message.id}
                className={`prisma-chat__message prisma-chat__message--${message.role}`}
              >
                <span className="prisma-chat__message-label">
                  {message.role === "user" ? "Vos" : "Prisma"}
                </span>
                <p>{message.content}</p>
              </article>
            ))}
            {mutation.isPending && (
              <div className="prisma-chat__typing" role="status">
                <LoaderCircle size={15} className="prisma-chat__spinner" /> Prisma está respondiendo…
              </div>
            )}
            <div ref={endOfMessagesRef} />
          </div>
        )}
      </section>

      <footer className="prisma-chat__footer">
        {error && <p className="prisma-chat__error" role="alert">{error}</p>}
        <form
          className="prisma-chat__composer"
          onSubmit={(event) => { event.preventDefault(); send(); }}
        >
          <label className="sr-only" htmlFor="prisma-message">Escribí un mensaje para Prisma</label>
          <textarea
            id="prisma-message"
            value={draft}
            maxLength={4000}
            rows={2}
            placeholder="Escribí tu mensaje…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            disabled={mutation.isPending || ownerChanged}
          />
          <button
            type="submit"
            className="prisma-chat__send"
            aria-label="Enviar mensaje"
            disabled={!draft.trim() || mutation.isPending || ownerChanged}
          >
            {mutation.isPending
              ? <LoaderCircle size={17} className="prisma-chat__spinner" />
              : <Send size={17} />}
          </button>
        </form>
        <p className="prisma-chat__footnote">
          No envíes información sensible. Los mensajes se procesan por Router IA y no se guardan en CoreX.
        </p>
      </footer>
    </main>
  );
}