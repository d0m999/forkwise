CREATE TABLE `embeddings` (
	`chunk_id` integer NOT NULL,
	`model` text NOT NULL,
	`dimension` integer NOT NULL,
	`vector` text NOT NULL,
	PRIMARY KEY(`chunk_id`, `model`),
	FOREIGN KEY (`chunk_id`) REFERENCES `search_chunks`(`rowid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `search_chunks` (
	`rowid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`version_id` text NOT NULL,
	`kind` text NOT NULL,
	`offset` integer NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chunk_identity` ON `search_chunks` (`version_id`,`offset`);--> statement-breakpoint
CREATE INDEX `project_chunks` ON `search_chunks` (`project_id`,`entity_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE VIRTUAL TABLE search_fts USING fts5(text, content='search_chunks', content_rowid='rowid', tokenize='trigram');
--> statement-breakpoint
CREATE TRIGGER search_chunks_ai AFTER INSERT ON search_chunks BEGIN
  INSERT INTO search_fts(rowid,text) VALUES(new.rowid,new.text);
END;
--> statement-breakpoint
CREATE TRIGGER search_chunks_ad AFTER DELETE ON search_chunks BEGIN
  INSERT INTO search_fts(search_fts,rowid,text) VALUES('delete',old.rowid,old.text);
END;
--> statement-breakpoint
CREATE TRIGGER search_chunks_au AFTER UPDATE ON search_chunks BEGIN
  INSERT INTO search_fts(search_fts,rowid,text) VALUES('delete',old.rowid,old.text);
  INSERT INTO search_fts(rowid,text) VALUES(new.rowid,new.text);
END;
