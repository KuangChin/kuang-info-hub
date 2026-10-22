declare module "google-news-url-decoder" {
  export type DecodeResult = {
    status: boolean;
    decoded_url?: string;
    message?: string;
  };

  export class GoogleDecoder {
    decode(sourceUrl: string): Promise<DecodeResult>;
  }
}
