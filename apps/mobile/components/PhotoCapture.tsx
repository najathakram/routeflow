import {
  Alert,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { colors, borderRadius } from "@routeflow/ui/tokens";

interface Props {
  photos: string[]; // array of local URIs
  onAdd: (uri: string) => void;
  onRemove: (uri: string) => void;
  maxPhotos?: number;
  label?: string;
}

export function PhotoCapture({
  photos,
  onAdd,
  onRemove,
  maxPhotos = 3,
  label = "Add Photo",
}: Props) {
  const canAdd = photos.length < maxPhotos;

  const handleCapture = async () => {
    // On web, use image library; on native prefer camera
    if (Platform.OS === "web") {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.7,
        allowsEditing: false,
      });
      if (!result.canceled && result.assets[0]) {
        onAdd(result.assets[0].uri);
      }
      return;
    }

    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Camera access is required to capture proof of delivery.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
      allowsEditing: false,
    });
    if (!result.canceled && result.assets[0]) {
      onAdd(result.assets[0].uri);
    }
  };

  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {photos.map((uri) => (
          <View key={uri} style={styles.thumb}>
            <Image source={{ uri }} style={styles.thumbImg} />
            <Pressable style={styles.removeBtn} onPress={() => onRemove(uri)}>
              <Ionicons name="close-circle" size={20} color={colors.danger.DEFAULT} />
            </Pressable>
          </View>
        ))}
        {canAdd && (
          <Pressable style={styles.addBtn} onPress={handleCapture}>
            <Ionicons name="camera-outline" size={24} color={colors.brand[500]} />
            <Text style={styles.addBtnText}>{label}</Text>
          </Pressable>
        )}
      </ScrollView>
      {photos.length > 0 && (
        <Text style={styles.hint}>
          {photos.length} / {maxPhotos} photo{photos.length !== 1 ? "s" : ""}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 6 },
  row: { gap: 10, paddingVertical: 2 },
  thumb: {
    width: 80,
    height: 80,
    borderRadius: borderRadius.DEFAULT,
    overflow: "hidden",
    position: "relative",
  },
  thumbImg: { width: 80, height: 80 },
  removeBtn: {
    position: "absolute",
    top: 2,
    right: 2,
    backgroundColor: "#fff",
    borderRadius: 10,
  },
  addBtn: {
    width: 80,
    height: 80,
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: colors.brand[500],
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    backgroundColor: colors.brand[50],
  },
  addBtnText: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[500],
    textAlign: "center",
  },
  hint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
});
