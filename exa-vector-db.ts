/**
 * Exa.ai-style Vector Database
 * SQLite + binary quantization for memory-efficient semantic search
 * BGE-M3 embeddings (1024-dim) with cosine similarity reranking
 *
 * Binary quantization: 1024 float32 (4096 bytes) → 1024 bits (128 bytes) = 32x savings
 */

import { Database } from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import {
	quantize,
	dequantize,
	cosineSimilarity,
	binaryCosineSimilarity,
	type QuantizationResult,
} from "./binary-quantizer.js";

const DB_PATH = join(homedir(), ".pi", "exa-vector-db.sqlite");
const EMBEDDING_DIMENSIONS = 1024;
const BYTES_PER_EMBEDDING = Math.ceil(EMBEDDING_DIMENSIONS / 8); // 128 bytes

export interface Document {
	id: string;
	url: string;
	title: string;
	content: string;
	embedding: number[];
	embeddingBinary?: Uint8Array; // Binary quantized version (optional, computed on demand)
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
	db.pragma(" synchronous = NORMAL");

	db.exec(`
		CREATE TABLE IF NOT EXISTS documents (
			id TEXT PRIMARY KEY,
			url TEXT NOT NULL UNIQUE,
			title TEXT NOT NULL,
			content TEXT NOT NULL,
			embedding_binary BLOB NOT NULL,  -- 128 bytes per embedding (binary quantized)
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
 * Encode embedding to binary quantized format
 * Converts float32 (4096 bytes) to binary (128 bytes) = 32x compression
 */
function encodeEmbeddingBinary(embedding: number[]): Uint8Array {
	const float32Array = new Float32Array(embedding);
	const result = quantize(float32Array, { dimensions: EMBEDDING_DIMENSIONS });
	return result.binary;
}

/**
 * Decode binary quantized embedding back to float32
 */
function decodeEmbeddingBinary(binary: Uint8Array | string): number[] {
	// Handle both Uint8Array and string (from SQLite)
	let bin: Uint8Array;
	if (typeof binary === "string") {
		bin = new Uint8Array(binary.split("\0").map((c) => c.charCodeAt(0)));
	} else {
		bin = binary;
	}
	const result = dequantize(bin, { dimensions: EMBEDDING_DIMENSIONS });
	return Array.from(result);
}

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) return 0;
	let dotProduct = 0, normA = 0, normB = 0;
	for (let i = 0; i < a.length; i++) {
		dotProduct += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

/**
 * Add document to vector DB with binary quantized embedding
 */
export function addDocument(doc: Document): void {
	const d = getDB();

	// Convert to binary quantized format
	const binaryEmbedding = encodeEmbeddingBinary(doc.embedding);

	d.prepare(`
		INSERT OR REPLACE INTO documents (id, url, title, content, embedding_binary, metadata)
		VALUES (?, ?, ?, ?, ?, ?)
	`).run(
		doc.id,
		doc.url,
		doc.title,
		doc.content,
		Buffer.from(binaryEmbedding.buffer, binaryEmbedding.byteOffset, binaryEmbedding.byteLength),
		JSON.stringify(doc.metadata || {}),
	);
}

/**
 * Search by semantic similarity using binary cosine similarity
 * Uses Hamming distance approximation for fast binary comparison
 */
export function searchSimilar(queryEmbedding: number[], limit: number = 10): SearchResult[] {
	const d = getDB();

	// Convert query to binary
	const queryBinary = encodeEmbeddingBinary(queryEmbedding);

	// Get recent documents (Exa.ai uses clustering; we use recency as proxy)
	const rows = d.prepare(`
		SELECT id, url, title, content, embedding_binary, metadata
		FROM documents
		ORDER BY created_at DESC
		LIMIT 1000
	`).all() as Array<{
		id: string;
		url: string;
		title: string;
		content: string;
		embedding_binary: Buffer;
		metadata: string;
	}>;

	// Compute binary cosine similarity for each document
	const results: SearchResult[] = rows.map((row) => {
		const rowBinary = new Uint8Array(row.embedding_binary.buffer, row.embedding_binary.byteOffset, row.embedding_binary.byteLength);
		const similarityResult = binaryCosineSimilarity(queryBinary, rowBinary, { dimensions: EMBEDDING_DIMENSIONS });
		
		return {
			document: {
				id: row.id,
				url: row.url,
				title: row.title,
				content: row.content,
				embedding: decodeEmbeddingBinary(rowBinary),
				metadata: JSON.parse(row.metadata),
			},
			similarity: similarityResult.similarity,
		};
	});

	// Sort by similarity and return top results
	return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
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
