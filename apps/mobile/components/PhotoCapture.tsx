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
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { colors, borderRadius } from "@routeflow/ui/tokens";

interface Props {
  photos: string[]; // array of local URIs (or data URLs in "data-url" mode)
  onAdd: (uri: string) => void;
  onRemove: (uri: string) => void;
  maxPhotos?: number;
  label?: string;
  /**
   * "data-url" emits a resized/compressed JPEG data URL instead of the
   * device-local picker URI. Used for POD photos, which upload as JSON data
   * URLs (the offline queue can't replay FormData) — a device URI would be
   * persisted verbatim server-side and never be retrievable.
   */
  output?: "uri" | "data-url";
}

// Keep POD attaches well under the API's 2MB JSON body limit while staying
// legible for dispute review (boxes at a door, not product photography).
const DATA_URL_MAX_WIDTH = 1280;
const DATA_URL_JPEG_QUALITY = 0.6;

export function PhotoCapture({
  photos,
  onAdd,
  onRemove,
  maxPhotos = 3,
  label = "Add Photo",
  output = "uri",
}: Props) {
  const canAdd = photos.length < maxPhotos;

  const emit = async (asset: ImagePicker.ImagePickerAsset) => {
    if (output !== "data-url") {
      onAdd(asset.uri);
      return;
    }
    try {
      const resize =
        asset.width && asset.width > DATA_URL_MAX_WIDTH
          ? [{ resize: { width: DATA_URL_MAX_WIDTH } }]
          : [];
      const jpeg = await manipulateAsync(asset.uri, resize, {
        compress: DATA_URL_JPEG_QUALITY,
        format: SaveFormat.JPEG,
        base64: true,
      });
      if (jpeg.base64) {
        onAdd(`data:image/jpeg;base64,${jpeg.base64}`);
        return;
      }
      onAdd(asset.uri);
    } catch {
      // Transcode failed (exotic format): fall back to the local URI so the
      // driver still sees the photo — it just won't upload (pre-change behavior).
      onAdd(asset.uri);
    }
  };

  const handleCapture = async () => {
    // On web, use image library; on native prefer camera
    if (Platform.OS === "web") {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.7,
        allowsEditing: false,
      });
      if (!result.canceled && result.assets[0]) {
        await emit(result.assets[0]);
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
      await emit(result.assets[0]);
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
