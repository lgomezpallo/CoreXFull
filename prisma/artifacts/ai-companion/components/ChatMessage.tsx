import { Ionicons } from '@expo/vector-icons';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import type { ConversationMessage } from '@/contexts/ConversationsContext';

interface ChatMessageProps {
  message: ConversationMessage;
  onExport?: (message: ConversationMessage) => void;
}

function readableText(text: string) {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '');
}

export default function ChatMessage({
  message,
  onExport,
}: ChatMessageProps) {
  const colors = useColors();
  const isUser = message.role === 'user';
  const isImage = !!message.imageUri;

  return (
    <View
      style={[
        styles.row,
        isUser ? styles.userRow : styles.assistantRow,
      ]}
      testID={`message-${message.id}`}
    >
      {!isUser && !isImage ? (
        <View
          style={[
            styles.assistantMark,
            { backgroundColor: colors.accent },
          ]}
        >
          <Ionicons name="sparkles" size={14} color={colors.accentForeground} />
        </View>
      ) : null}
      <View
        style={[
          styles.content,
          isUser
            ? [styles.userBubble, { backgroundColor: colors.primary }]
            : styles.assistantContent,
        ]}
      >
        {isImage ? (
          <Image
            source={{ uri: message.imageUri }}
            resizeMode="cover"
            style={styles.generatedImage}
            accessibilityLabel="Imagen generada por Prisma"
          />
        ) : (
          <Text
            style={[
              styles.messageText,
              {
                color: isUser
                  ? colors.primaryForeground
                  : message.error
                    ? colors.destructive
                    : colors.foreground,
              },
            ]}
          >
            {readableText(message.content)}
          </Text>
        )}
        {!isUser && message.mode === 'document' && !message.error ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Exportar documento a PDF"
            testID={`export-pdf-${message.id}`}
            onPress={() => onExport?.(message)}
            style={({ pressed }) => [
              styles.exportButton,
              {
                backgroundColor: colors.secondary,
                opacity: pressed ? 0.72 : 1,
              },
            ]}
          >
            <Ionicons
              name="document-text-outline"
              size={17}
              color={colors.secondaryForeground}
            />
            <Text
              style={[
                styles.exportText,
                { color: colors.secondaryForeground },
              ]}
            >
              Exportar PDF
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    width: '100%',
    flexDirection: 'row',
    gap: 9,
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  userRow: {
    justifyContent: 'flex-end',
  },
  assistantRow: {
    justifyContent: 'flex-start',
  },
  assistantMark: {
    width: 25,
    height: 25,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  content: {
    maxWidth: '84%',
  },
  userBubble: {
    paddingHorizontal: 15,
    paddingVertical: 11,
    borderRadius: 19,
    borderBottomRightRadius: 6,
  },
  assistantContent: {
    flex: 1,
    paddingTop: 2,
  },
  messageText: {
    fontFamily: 'Inter_400Regular',
    fontSize: 15,
    lineHeight: 23,
  },
  generatedImage: {
    width: 250,
    height: 250,
    borderRadius: 20,
    backgroundColor: '#e9efe7',
  },
  exportButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderRadius: 14,
    marginTop: 14,
  },
  exportText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 13,
  },
});