import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React from 'react';
import {
  Alert,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  useConversations,
  type SavedConversation,
} from '@/contexts/ConversationsContext';
import { useColors } from '@/hooks/useColors';

function lastMessage(conversation: SavedConversation) {
  const last = conversation.messages[conversation.messages.length - 1];
  if (!last) return 'Todavía no hay mensajes';
  if (last.imageUri) return 'Imagen generada';
  return last.content.replace(/\s+/g, ' ').slice(0, 72);
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('es-AR', {
    day: 'numeric',
    month: 'short',
  }).format(date);
}

export default function HistoryScreen() {
  const colors = useColors();
  const {
    conversations,
    selectConversation,
    deleteConversation,
    startFreshConversation,
  } = useConversations();

  function confirmDelete(item: SavedConversation) {
    Alert.alert('Eliminar conversación', `Se eliminará “${item.title}”.`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Eliminar',
        style: 'destructive',
        onPress: () => void deleteConversation(item.id),
      },
    ]);
  }

  return (
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
          accessibilityLabel="Volver al chat"
          testID="history-back"
          onPress={() => router.back()}
          style={({ pressed }) => [
            styles.iconButton,
            { backgroundColor: colors.secondary, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Ionicons
            name="arrow-back"
            size={20}
            color={colors.secondaryForeground}
          />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>
          Conversaciones
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Empezar conversación nueva"
          testID="history-new"
          onPress={() => {
            startFreshConversation();
            router.back();
          }}
          style={({ pressed }) => [
            styles.iconButton,
            { backgroundColor: colors.secondary, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Ionicons name="add" size={23} color={colors.secondaryForeground} />
        </Pressable>
      </View>

      {conversations.length === 0 ? (
        <View style={styles.empty}>
          <View style={[styles.emptyMark, { backgroundColor: colors.accent }]}>
            <Ionicons
              name="chatbubbles-outline"
              size={23}
              color={colors.accentForeground}
            />
          </View>
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            Aún no hay conversaciones
          </Text>
          <Text style={[styles.emptyCopy, { color: colors.mutedForeground }]}>
            Tus chats aparecerán aquí y se guardan solo en este dispositivo.
          </Text>
        </View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <View
              style={[
                styles.conversationRow,
                { borderBottomColor: colors.border },
              ]}
            >
              <Pressable
                accessibilityRole="button"
                testID={`conversation-${item.id}`}
                onPress={() => {
                  selectConversation(item.id);
                  router.back();
                }}
                style={({ pressed }) => [
                  styles.conversationMain,
                  { opacity: pressed ? 0.7 : 1 },
                ]}
              >
                <Text
                  style={[styles.conversationTitle, { color: colors.foreground }]}
                  numberOfLines={1}
                >
                  {item.title}
                </Text>
                <Text
                  style={[
                    styles.conversationPreview,
                    { color: colors.mutedForeground },
                  ]}
                  numberOfLines={1}
                >
                  {lastMessage(item)}
                </Text>
                <Text style={[styles.date, { color: colors.mutedForeground }]}>
                  {formatDate(item.updatedAt)}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Eliminar ${item.title}`}
                testID={`delete-${item.id}`}
                onPress={() => confirmDelete(item)}
                style={({ pressed }) => [
                  styles.deleteButton,
                  { opacity: pressed ? 0.55 : 1 },
                ]}
              >
                <Ionicons
                  name="trash-outline"
                  size={18}
                  color={colors.mutedForeground}
                />
              </Pressable>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  header: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontFamily: 'Inter_600SemiBold',
    fontSize: 17,
  },
  list: {
    paddingHorizontal: 18,
  },
  conversationRow: {
    minHeight: 92,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  conversationMain: {
    flex: 1,
    paddingVertical: 16,
    paddingRight: 12,
  },
  conversationTitle: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 15,
    marginBottom: 5,
  },
  conversationPreview: {
    fontFamily: 'Inter_400Regular',
    fontSize: 12,
  },
  date: {
    fontFamily: 'Inter_400Regular',
    fontSize: 10,
    marginTop: 7,
  },
  deleteButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 36,
  },
  emptyMark: {
    width: 54,
    height: 54,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 17,
  },
  emptyTitle: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 17,
    textAlign: 'center',
  },
  emptyCopy: {
    fontFamily: 'Inter_400Regular',
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
    marginTop: 8,
  },
});