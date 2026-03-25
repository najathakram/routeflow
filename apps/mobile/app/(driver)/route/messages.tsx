import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRef, useState } from "react";
import { Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useMessages, useSendMessage, type Message } from "../../../lib/api/messages";
import { useAuthStore } from "../../../lib/auth-store";

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function MessageBubble({ msg, isOwn }: { msg: Message; isOwn: boolean }) {
  return (
    <View style={[styles.bubbleWrapper, isOwn ? styles.bubbleWrapperOwn : styles.bubbleWrapperOther]}>
      {!isOwn && (
        <Text style={styles.senderName}>
          {msg.sender.username} · {msg.senderRole}
        </Text>
      )}
      <View style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleOther]}>
        <Text style={[styles.bubbleText, isOwn ? styles.bubbleTextOwn : styles.bubbleTextOther]}>
          {msg.text}
        </Text>
      </View>
      <Text style={[styles.bubbleTime, isOwn ? styles.bubbleTimeOwn : undefined]}>
        {formatTime(msg.createdAt)}
      </Text>
    </View>
  );
}

export default function MessagesScreen() {
  const { runId } = useLocalSearchParams<{ runId: string }>();
  const currentUser = useAuthStore((s) => s.user);

  const { data: messages, isLoading } = useMessages(runId ?? "");
  const { mutate: sendMessage, isPending: isSending } = useSendMessage(runId ?? "");

  const [text, setText] = useState("");
  const listRef = useRef<FlatList<Message>>(null);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || isSending) return;
    setText("");
    sendMessage(
      { runId: runId ?? undefined, text: trimmed },
      {
        onSuccess: () => {
          setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
        },
      },
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: "Messages", headerBackTitle: "Route" }} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={88}
      >
        <View style={styles.container}>
          {isLoading ? (
            <View style={styles.centered}>
              <ActivityIndicator size="large" color={colors.brand[500]} />
            </View>
          ) : (
            <FlatList
              ref={listRef}
              data={messages ?? []}
              keyExtractor={(m) => m.id}
              contentContainerStyle={styles.list}
              showsVerticalScrollIndicator={false}
              onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
              ListEmptyComponent={
                <View style={styles.emptyState}>
                  <Ionicons name="chatbubbles-outline" size={48} color="#cbd5e1" />
                  <Text style={styles.emptyText}>No messages yet.</Text>
                  <Text style={styles.emptySubtext}>
                    Send a message to your dispatcher.
                  </Text>
                </View>
              }
              renderItem={({ item }) => (
                <MessageBubble
                  msg={item}
                  isOwn={item.senderId === currentUser?.id}
                />
              )}
            />
          )}

          {/* Input bar */}
          <View style={styles.inputBar}>
            <TextInput
              style={styles.textInput}
              placeholder="Type a message…"
              placeholderTextColor="#94a3b8"
              value={text}
              onChangeText={setText}
              multiline
              maxLength={2000}
              returnKeyType="default"
              blurOnSubmit={false}
            />
            <Pressable
              style={[styles.sendBtn, (!text.trim() || isSending) && styles.sendBtnDisabled]}
              onPress={handleSend}
              disabled={!text.trim() || isSending}
              accessibilityLabel="Send message"
            >
              {isSending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="send" size={18} color="#fff" />
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.raised,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  list: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
    gap: 12,
  },
  emptyState: {
    alignItems: "center",
    paddingTop: 64,
    gap: 8,
  },
  emptyText: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
  },
  emptySubtext: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  bubbleWrapper: {
    maxWidth: "80%",
    gap: 3,
  },
  bubbleWrapperOwn: {
    alignSelf: "flex-end",
    alignItems: "flex-end",
  },
  bubbleWrapperOther: {
    alignSelf: "flex-start",
    alignItems: "flex-start",
  },
  senderName: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: "#94a3b8",
    marginBottom: 2,
    marginLeft: 4,
  },
  bubble: {
    borderRadius: borderRadius.lg,
    paddingHorizontal: 14,
    paddingVertical: 10,
    ...shadows.card,
  },
  bubbleOwn: {
    backgroundColor: colors.brand[500],
    borderBottomRightRadius: 4,
  },
  bubbleOther: {
    backgroundColor: "#fff",
    borderBottomLeftRadius: 4,
  },
  bubbleText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },
  bubbleTextOwn: {
    color: "#fff",
  },
  bubbleTextOther: {
    color: colors.navy.DEFAULT,
  },
  bubbleTime: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    marginHorizontal: 4,
  },
  bubbleTimeOwn: {
    textAlign: "right",
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    paddingBottom: 28,
    backgroundColor: "#fff",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  textInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.lg,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    backgroundColor: colors.surface.raised,
    textAlignVertical: "top",
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.brand[500],
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  sendBtnDisabled: {
    opacity: 0.4,
  },
});
