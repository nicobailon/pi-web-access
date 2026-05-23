/**
 * Exa.ai-style Vector Database
 * SQLite + full precision embeddings for semantic search
 * Nomic Embed v1.5 embeddings (256-dim Matryoshka)
 * 
 * Full precision: 256 float32 (1024 bytes) per embedding
 * 1M docs = 1GB RAM
 * Plan explicitly recommends full precision over binary quantization
 * to avoid the 15-30% accuracy loss from binary quantization
 */

import Database from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";

const DB_PATH = join(homedir(), ".pi", "exa-vector-db.sqlite");
const EMBEDDING_DIMENSIONS = 256; // Nomic Embed v1.5 truncated to 256-dim
const BYTES_PER_EMBEDDING = EMBEDDING_DIMENSIONS * 4; // 1024 bytes (full precision)

export interface Document {
	id: string;
	url: string;
	title: string;
	content: string;
	embedding: number[];
	metadata?: Record<string, unknown>;
}

export interface SearchResult {
	document: Document;
	similarity: number;
}

/**
 * Initialize the vector database
 */
function initDB(): Database {
	const dir = join(homedir(), ".pi");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	const db = new Database(DB_PATH);
	db.pragma("journal_mode = WAL");
	db.pragma("synchronous = NORMAL");

	db.exec(`
		CREATE TABLE IF NOT EXISTS documents (
			id TEXT PRIMARY KEY,
			url TEXT NOT NULL UNIQUE,
			title TEXT NOT NULL,
			content TEXT NOT NULL,
			embedding BLOB NOT NULL,  -- 1024 bytes per embedding (full precision float32)
			metadata TEXT,
			created_at INTEGER DEFAULT (strftime('%s', 'now'))
		);
		CREATE INDEX IF NOT EXISTS idx_url ON documents(url);
		CREATE INDEX IF NOT EXISTS idx_created ON documents(created_at);
	`);

	return db;
}

let db: Database | null = null;

function getDB(): Database {
	if (!db) db = initDB();
	return db;
}

/**
 * Convert number[] to Float32Array for storage
 */
function embeddingToBlob(embedding: number[]): Buffer {
	const float32Array = new Float32Array(embedding);
	return Buffer.from(float32Array.buffer, float32Array.byteOffset, float32Array.byteLength);
}

/**
 * Convert stored blob back to number[]
 */
function blobToEmbedding(blob: Buffer): number[] {
	const float32Array = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength);
	return Array.from(float32Array);
}

/**
 * Add document to vector DB with full precision embedding
 */
export function addDocument(doc: Document): void {
	const d = getDB();

	d.prepare(`
		INSERT OR REPLACE INTO documents (id, url, title, content, embedding, metadata)
		VALUES (?, ?, ?, ?, ?, ?)
	`).run(
		doc.id,
		doc.url,
		doc.title,
		doc.content,
		embeddingToBlob(doc.embedding),
		JSON.stringify(doc.metadata || {}),
	);
}

/**
 * Search by semantic similarity using cosine similarity
 * Computes cosine similarity between query embedding and stored embeddings
 */
export function searchSimilar(queryEmbedding: number[], limit: number = 10): SearchResult[] {
	const d = getDB();

	// Get recent documents (Exa.ai uses clustering; we use recency as proxy)
	const rows = d.prepare(`
		SELECT id, url, title, content, embedding, metadata
		FROM documents
		ORDER BY created_at DESC
		LIMIT 1000
	`).all() as Array<{
		id: string;
		url: string;
		title: string;
		content: string;
		embedding: Buffer;
		metadata: string;
	}>;

	// Compute cosine similarity for each document
	const results: SearchResult[] = rows.map((row) => {
		const docEmbedding = blobToEmbedding(row.embedding);
		const similarity = cosineSimilarity(queryEmbedding, docEmbedding);
		
		return {
			document: {
				id: row.id,
				url: row.url,
				title: row.title,
				content: row.content,
				embedding: docEmbedding,
				metadata: JSON.parse(row.metadata),
			},
			similarity,
		};
	});

	// Sort by similarity and return top results
	return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

/**
 * Compute cosine similarity between two embeddings
 */
function cosineSimilarity(a: number[], b: number[]): number {
	let dotProduct = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dotProduct += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	normA = Math.sqrt(normA);
	normB = Math.sqrt(normB);

	if (normA === 0 || normB === 0) return 0;
	return dotProduct / (normA * normB);
}

/**
 * Remove document
 */
export function removeDocument(id: string): void {
	getDB().prepare("DELETE FROM documents WHERE id = ?").run(id);
}

/**
 * Get document count
 */
export function getDocumentCount(): number {
	return getDB().prepare("SELECT COUNT(*) as count FROM documents").get() as { count: number };
}

/**
 * Clear all documents
 */
export function clearDocuments(): void {
	getDB().exec("DELETE FROM documents");
}
