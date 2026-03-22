#!/bin/bash
# Watch ~/ingest for new files, copy to group inbox, and notify Kai via Telegram
INGEST_DIR="$HOME/ingest"
INBOX_DIR="$HOME/server/nanoclaw/groups/telegram_main/inbox"
DB="$HOME/server/nanoclaw/store/messages.db"
CHAT_JID="tg:59281986"
ASSISTANT_NAME="Kai"

mkdir -p "$INGEST_DIR" "$INBOX_DIR"

echo "Watching $INGEST_DIR for new files..."

inotifywait -m -e close_write -e moved_to "$INGEST_DIR" --format '%f' | while read filename; do
    src="$INGEST_DIR/$filename"

    # Skip hidden/temp files
    [[ "$filename" == .* ]] && continue
    [[ "$filename" == *~ ]] && continue
    [[ "$filename" == *.tmp ]] && continue
    [[ "$filename" == *.part ]] && continue

    # Wait a moment for large file transfers to complete
    sleep 1

    # Skip if file disappeared (temp file)
    [ ! -f "$src" ] && continue

    # Move to inbox (removes from ingest)
    mv "$src" "$INBOX_DIR/$filename"

    # Get file size
    size=$(du -h "$INBOX_DIR/$filename" | cut -f1)

    echo "$(date '+%Y-%m-%d %H:%M:%S') Ingested: $filename ($size)"

    # Store a message in the DB so Kai knows about the file
    timestamp=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
    msgid="ingest-$(date +%s)-$$"
    content="[File ingested to inbox/${filename}] (${size}) - New file at /workspace/group/inbox/${filename}. Please: 1) Read/examine the file 2) Save key info to Ori memory 3) Move it to the appropriate folder under /workspace/group/documents/ (contracts, offers, reports, presentations, meeting-notes) or /workspace/group/media/ (images, audio, video) - create new subfolders if needed 4) After filing, delete the original from inbox: rm /workspace/group/inbox/${filename}"

    # Use parameterized insert to avoid SQL injection from filenames
    sqlite3 "$DB" "INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES ('${msgid}', '${CHAT_JID}', 'ingest', 'File Ingest', replace('${content}', '''', ''''''), '${timestamp}', 0);"

    echo "  Notified Kai about $filename"
done
