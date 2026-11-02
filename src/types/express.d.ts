declare global {
  namespace Express {
    interface Request {
      auth?: {
        apiKey: string;
        userId: string;
      };
    }
  }
}

export {};
