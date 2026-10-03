import { Ionicons } from '@expo/vector-icons';
import { useGenerateAiImage } from '@workspace/api-client-react';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import ChatComposer, { type SelectedPrismaImage } from '@/components/ChatComposer';
import ChatMessage from '@/components/ChatMessage';
import {
  useConversations,
  type ChatMode,
  type ConversationMessage,
} from '@/contexts/ConversationsContext';
import { useColors } from '@/hooks/useColors';
import { streamAiReply, saveGeneratedImage } from '@/lib/ai';
import { exportAsPdf } from '@/lib/documents';

let messageCounter = 0;

function makeMessageId() {
  messageCounter += 1;
  return `msg-${Date.now()}-${messageCounter}-${Math.random().toString(36).slice(2, 9)}`;
}

const suggestions = [
  'Ayúdame a ordenar mis ideas',
  'Escribe un correo con buen tono',
  'Dame ideas para un proyecto',
];

function TypingIndicator() {
  const colors = useColors();
  return (
    <View style={styles.typingRow}>
      <View style={[styles.typingMark, { backgroundColor: colors.accent }]}>
        <Ionicons name="sparkles" size={14} color={colors.accentForeground} />
      </View>
      <View style={styles.typingContent}>
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={[styles.typingText, { color: colors.mutedForeground }]}>
          Prisma está pensando
        </Text>
      </View>
    </View>
  );
}

export default function ChatScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);
  const loadedConversationRef = useRef<string | null>(null);
  const creatingConversationRef = useRef(false);
  const {
    conversations,
    activeConversationId,
    isLoaded,
    createConversation,
    saveConversation,
    startFreshConversation,
  } = useConversations();
  const imageMutation = useGenerateAiImage();
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [mode, setMode] = useState<ChatMode>('chat');
  const [draft, setDraft] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeConversationId),
    [conversations, activeConversationId],
  );

  useEffect(() => {
    if (!isLoaded || creatingConversationRef.current) return;
    if (loadedConversationRef.current === activeConversationId) return;
    loadedConversationRef.current = activeConversationId;
    setMessages(activeConversation?.messages ?? []);
    setNotice('');
    setDraft('');
    setMode('chat');
  }, [activeConversationId, activeConversation, isLoaded]);

  async function persist(
    conversationId: string | null,
    updatedMessages: ConversationMessage[],
  ) {
    if (!conversationId) return;
    try {
      await saveConversation(conversationId, updatedMessages);
    } catch {
      setNotice('No se pudieron guardar los cambios en este dispositivo.');
    }
  }

  async function handleSend(
    attachment: SelectedPrismaImage | null = null,
    text = draft.trim(),
  ) {
    if ((!text && !attachment) || isBusy || !isLoaded) return;
    const visibleText = text || 'Imagen adjunta';
    const currentMessages = messages;
    const userMessage: ConversationMessage = {
      id: makeMessageId(),
      role: 'user',
      content: visibleText,
      createdAt: new Date().toISOString(),
      mode,
      imageUri: attachment?.uri,
    };
    const withUserMessage = [...currentMessages, userMessage];
    let finalMessages = withUserMessage;
    let conversationId = activeConversationId;
    let assistantText = '';
    const assistantId = makeMessageId();
    const assistantCreatedAt = new Date().toISOString();

    setDraft('');
    setNotice('');
    setMessages(withUserMessage);
    setIsBusy(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    try {
      if (!conversationId) {
        creatingConversationRef.current = true;
        conversationId = await createConversation(visibleText);
        loadedConversationRef.current = conversationId;
        creatingConversationRef.current = false;
      }

      if (mode === 'image') {
        const generated = await imageMutation.mutateAsync({
          data: { prompt: visibleText, size: '1024x1024' },
        });
        const imageUri = await saveGeneratedImage(
          generated.b64_json,
          assistantId,
        );
        const imageMessage: ConversationMessage = {
          id: assistantId,
          role: 'assistant',
          content: 'Imagen creada',
          createdAt: assistantCreatedAt,
          mode: 'image',
          imageUri,
        };
        finalMessages = [...withUserMessage, imageMessage];
        setMessages(finalMessages);
      } else {
        const chatHistory = [...withUserMessage]
          .filter((message) => message.mode !== 'image')
          .slice(-40)
          .map((message) => ({
            role: message.role,
            content: message.content,
          }));

        await streamAiReply(
          chatHistory,
          mode,
          conversationId,
          (chunk) => {
            assistantText += chunk;
            const assistantMessage: ConversationMessage = {
              id: assistantId,
              role: 'assistant',
              content: assistantText,
              createdAt: assistantCreatedAt,
              mode,
            };
            finalMessages = [...withUserMessage, assistantMessage];
            setMessages(finalMessages);
          },
          attachment
            ? { data: attachment.data, mimeType: attachment.mimeType }
            : undefined,
        );
      }
    } catch (error) {
      creatingConversationRef.current = false;
      const errorMessage: ConversationMessage = {
        id: assistantId,
        role: 'assistant',
        content:
          error instanceof Error
            ? error.message
            : 'Ocurrió un error. Inténtalo de nuevo.',
        createdAt: assistantCreatedAt,
        mode,
        error: true,
      };
      finalMessages = [...withUserMessage, errorMessage];
      setMessages(finalMessages);
    } finally {
      await persist(conversationId, finalMessages);
      setIsBusy(false);
    }
  }

  function startNewChat() {
    startFreshConversation();
    loadedConversationRef.current = null;
    setMessages([]);
    setDraft('');
    setNotice('');
    setMode('chat');
  }

  async function handleExport(message: ConversationMessage) {
    try {
      await exportAsPdf(activeConversation?.title ?? 'Documento de Prisma', message.content);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'No se pudo exportar el documento.',
      );
    }
  }

  const listData = useMemo(() => [...messages].reverse(), [messages]);
  const composerBottomPadding =
    Platform.OS === 'web' ? 34 : Math.max(insets.bottom, 10);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior="padding"
      keyboardVerticalOffset={0}
    >
      <SafeAreaView
        edges={['top']}
        style={[
          styles.safeArea,
          {
            backgroundColor: colors.background,
            paddingTop: Platform.OS === 'web' ? 67 : 0,
          },
        ]}
      >
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Ver conversaciones"
            testID="open-history"
            disabled={isBusy}
            onPress={() => router.push('/history')}
            style={({ pressed }) => [
              styles.headerIcon,
              {
                backgroundColor: colors.secondary,
                opacity: isBusy ? 0.5 : pressed ? 0.7 : 1,
              },
            ]}
          >
            <Ionicons
              name="time-outline"
              size={20}
              color={colors.secondaryForeground}
            />
          </Pressable>
          <View style={styles.brand}>
            <Text style={[styles.brandName, { color: colors.foreground }]}>
              Prisma
            </Text>
            <Text style={[styles.brandSubtitle, { color: colors.mutedForeground }]}>
              Tu espacio de ideas
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Nueva conversación"
            testID="new-conversation"
            disabled={isBusy}
            onPress={startNewChat}
            style={({ pressed }) => [
              styles.headerIcon,
              {
                backgroundColor: colors.secondary,
                opacity: isBusy ? 0.5 : pressed ? 0.7 : 1,
              },
            ]}
          >
            <Ionicons
              name="add"
              size={23}
              color={colors.secondaryForeground}
            />
          </Pressable>
        </View>

        {notice ? (
          <View
            accessibilityRole="alert"
            style={[styles.notice, { backgroundColor: colors.secondary }]}
          >
            <Text style={[styles.noticeText, { color: colors.secondaryForeground }]}>
              {notice}
            </Text>
            <Pressable onPress={() => setNotice('')} accessibilityLabel="Cerrar aviso">
              <Ionicons
                name="close"
                size={17}
                color={colors.secondaryForeground}
              />
            </Pressable>
          </View>
        ) : null}

        {!isLoaded ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : messages.length === 0 ? (
          <ScrollView
            style={styles.emptyScroll}
            contentContainerStyle={styles.emptyContent}
            keyboardShouldPersistTaps="handled"
          >
            <View
              style={[styles.welcomeMark, { backgroundColor: colors.accent }]}
            >
              <Ionicons
                name="sparkles"
                size={25}
                color={colors.accentForeground}
              />
            </View>
            <Text style={[styles.welcomeTitle, { color: colors.foreground }]}>
              ¿Qué te gustaría{'\n'}hacer hoy?
            </Text>
            <Text style={[styles.welcomeCopy, { color: colors.mutedForeground }]}>
              Conversa, analiza una imagen, crea una imagen o convierte una idea en un documento.
            </Text>
            <View style={styles.suggestionList}>
              {suggestions.map((suggestion, index) => (
                <Pressable
                  key={suggestion}
                  accessibilityRole="button"
                  testID={`suggestion-${index}`}
                  onPress={() => {
                    setMode('chat');
                    setDraft(suggestion);
                    inputRef.current?.focus();
                  }}
                  style={({ pressed }) => [
                    styles.suggestion,
                    {
                      backgroundColor: colors.card,
                      borderColor: colors.border,
                      opacity: pressed ? 0.72 : 1,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.suggestionText,
                      { color: colors.cardForeground },
                    ]}
                  >
                    {suggestion}
                  </Text>
                  <Ionicons
                    name="arrow-up"
                    size={17}
                    color={colors.mutedForeground}
                  />
                </Pressable>
              ))}
            </View>
          </ScrollView>
        ) : (
          <FlatList
            data={listData}
            inverted
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <ChatMessage message={item} onExport={handleExport} />
            )}
            ListHeaderComponent={isBusy ? <TypingIndicator /> : null}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.messageList}
            testID="conversation-messages"
          />
        )}

        <View style={{ paddingBottom: composerBottomPadding }}>
          <ChatComposer
            value={draft}
            onChangeText={setDraft}
            mode={mode}
            onModeChange={setMode}
            onSend={(attachment) => void handleSend(attachment)}
            isBusy={isBusy}
            inputRef={inputRef}
          />
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  header: {
    minHeight: 66,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerIcon: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brand: {
    flex: 1,
    alignItems: 'center',
  },
  brandName: {
    fontFamily: 'Inter_700Bold',
    fontSize: 18,
    letterSpacing: -0.4,
  },
  brandSubtitle: {
    fontFamily: 'Inter_400Regular',
    fontSize: 10,
    marginTop: 1,
  },
  notice: {
    marginHorizontal: 16,
    marginTop: 10,
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderRadius: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  noticeText: {
    flex: 1,
    fontFamily: 'Inter_500Medium',
    fontSize: 12,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyScroll: {
    flex: 1,
  },
  emptyContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingTop: 32,
    paddingBottom: 24,
  },
  welcomeMark: {
    width: 52,
    height: 52,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  welcomeTitle: {
    fontFamily: 'Inter_700Bold',
    fontSize: 32,
    lineHeight: 39,
    letterSpacing: -1.2,
  },
  welcomeCopy: {
    maxWidth: 300,
    fontFamily: 'Inter_400Regular',
    fontSize: 15,
    lineHeight: 22,
    marginTop: 10,
  },
  suggestionList: {
    gap: 9,
    marginTop: 28,
  },
  suggestion: {
    minHeight: 50,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 15,
  },
  suggestionText: {
    fontFamily: 'Inter_500Medium',
    fontSize: 13,
  },
  messageList: {
    paddingTop: 18,
    paddingBottom: 14,
  },
  typingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 18,
    paddingVertical: 13,
  },
  typingMark: {
    width: 25,
    height: 25,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  typingContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  typingText: {
    fontFamily: 'Inter_500Medium',
    fontSize: 13,
  },
});