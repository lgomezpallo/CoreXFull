import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';

export type ChatMode = 'chat' | 'image' | 'document';

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  mode: ChatMode;
  imageUri?: string;
  error?: boolean;
}

export interface SavedConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
}

interface ConversationsContextValue {
  conversations: SavedConversation[];
  activeConversationId: string | null;
  isLoaded: boolean;
  selectConversation: (id: string | null) => void;
  createConversation: (title: string) => Promise<string>;
  saveConversation: (
    id: string,
    messages: ConversationMessage[],
  ) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  startFreshConversation: () => void;
}

const STORAGE_KEY = 'nexo.conversations.v1';
const ConversationsContext =
  createContext<ConversationsContextValue | null>(null);

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sortNewestFirst(items: SavedConversation[]) {
  return [...items].sort(
    (left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  );
}

export function ConversationsProvider({ children }: PropsWithChildren) {
  const [conversations, setConversations] = useState<SavedConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const conversationsRef = useRef<SavedConversation[]>([]);

  useEffect(() => {
    let mounted = true;

    async function loadConversations() {
      try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY);
        if (!stored || !mounted) return;
        const parsed: unknown = JSON.parse(stored);
        if (!Array.isArray(parsed)) return;
        const valid = parsed.filter(
          (item): item is SavedConversation =>
            !!item &&
            typeof item === 'object' &&
            typeof item.id === 'string' &&
            typeof item.title === 'string' &&
            Array.isArray(item.messages),
        );
        const sorted = sortNewestFirst(valid);
        conversationsRef.current = sorted;
        setConversations(sorted);
        setActiveConversationId(sorted[0]?.id ?? null);
      } catch {
        // Keep the app usable if local conversation data cannot be read.
      } finally {
        if (mounted) setIsLoaded(true);
      }
    }

    void loadConversations();
    return () => {
      mounted = false;
    };
  }, []);

  const commit = useCallback(async (next: SavedConversation[]) => {
    const sorted = sortNewestFirst(next);
    conversationsRef.current = sorted;
    setConversations(sorted);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(sorted));
  }, []);

  const createConversation = useCallback(
    async (title: string) => {
      const now = new Date().toISOString();
      const id = newId();
      const conversation: SavedConversation = {
        id,
        title: title.trim().slice(0, 56) || 'Nueva conversación',
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      setActiveConversationId(id);
      await commit([conversation, ...conversationsRef.current]);
      return id;
    },
    [commit],
  );

  const saveConversation = useCallback(
    async (id: string, messages: ConversationMessage[]) => {
      const now = new Date().toISOString();
      const existing = conversationsRef.current.find((item) => item.id === id);
      const updated: SavedConversation = {
        id,
        title: existing?.title ?? 'Nueva conversación',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        messages,
      };
      await commit([
        updated,
        ...conversationsRef.current.filter((item) => item.id !== id),
      ]);
    },
    [commit],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      const next = conversationsRef.current.filter((item) => item.id !== id);
      await commit(next);
      if (activeConversationId === id) {
        setActiveConversationId(next[0]?.id ?? null);
      }
    },
    [activeConversationId, commit],
  );

  const selectConversation = useCallback((id: string | null) => {
    setActiveConversationId(id);
  }, []);

  const startFreshConversation = useCallback(() => {
    setActiveConversationId(null);
  }, []);

  const value = useMemo(
    () => ({
      conversations,
      activeConversationId,
      isLoaded,
      selectConversation,
      createConversation,
      saveConversation,
      deleteConversation,
      startFreshConversation,
    }),
    [
      conversations,
      activeConversationId,
      isLoaded,
      selectConversation,
      createConversation,
      saveConversation,
      deleteConversation,
      startFreshConversation,
    ],
  );

  return (
    <ConversationsContext.Provider value={value}>
      {children}
    </ConversationsContext.Provider>
  );
}

export function useConversations() {
  const context = useContext(ConversationsContext);
  if (!context) {
    throw new Error(
      'useConversations must be used inside ConversationsProvider.',
    );
  }
  return context;
}