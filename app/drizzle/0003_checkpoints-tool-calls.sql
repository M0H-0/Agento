CREATE TABLE `checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`tool_call_id` text,
	`path` text NOT NULL,
	`dest_path` text,
	`existed` integer NOT NULL,
	`content` text,
	`size` integer,
	`sha256` text,
	`before_excerpt` text,
	`after_excerpt` text,
	`reverted_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`tool_call_id` text,
	`tool` text NOT NULL,
	`input_json` text NOT NULL,
	`output_json` text,
	`ok` integer,
	`error` text,
	`risk_level` integer,
	`risk_source` text,
	`duration_ms` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
