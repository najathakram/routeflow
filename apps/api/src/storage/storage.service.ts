import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Presigned GET URL expiry: 1 hour
const GET_EXPIRY_SECONDS = 3600;

@Injectable()
export class StorageService {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    const accountId = config.get<string>("r2.accountId") ?? "";
    this.bucket = config.get<string>("r2.bucketName") ?? "routeflow-assets";
    this.s3 = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.get<string>("r2.accessKeyId") ?? "",
        secretAccessKey: config.get<string>("r2.secretAccessKey") ?? "",
      },
    });
  }

  /** Upload a file buffer to R2. Returns the stored object key. */
  async upload(
    key: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<string> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    );
    return key;
  }

  /** Delete an object from R2 by key. */
  async delete(key: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  /** Generate a presigned GET URL valid for 1 hour. */
  async presignedUrl(key: string): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: GET_EXPIRY_SECONDS },
    );
  }

  /** Generate presigned GET URLs for an array of keys. */
  async presignedUrls(keys: string[]): Promise<string[]> {
    return Promise.all(keys.map((k) => this.presignedUrl(k)));
  }
}
