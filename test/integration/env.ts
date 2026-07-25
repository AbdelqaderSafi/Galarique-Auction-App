import * as dotenv from 'dotenv';
import * as path from 'path';

// يُحمَّل قبل أي شيء آخر (Jest setupFiles) — لازم قبل ما DatabaseService يقرأ process.env.DATABASE_URL
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });
