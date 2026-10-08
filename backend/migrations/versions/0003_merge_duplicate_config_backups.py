"""merge duplicate config backups

A backend that was still running the code from before revision 0002 kept
comparing raw-text hashes with the normalised hashes stored by 0002. Nothing
matched, so it stored a new backup on every collection, with an old-style
hash. This repairs such data: every backup is hashed the normalised way, and
a backup with the same configuration as the one before it (for the same
host) is folded into that earlier backup.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-08

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from app.engine.config_diff import config_hash

# revision identifiers, used by Alembic.
revision: str = '0003'
down_revision: Union[str, Sequence[str], None] = '0002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

backups = sa.table(
    'config_backups',
    sa.column('id', sa.Integer),
    sa.column('host', sa.String),
    sa.column('last_seen_at', sa.DateTime(timezone=True)),
    sa.column('sha256', sa.String),
    sa.column('config', sa.Text),
)


def upgrade() -> None:
    connection = op.get_bind()
    rows = connection.execute(
        sa.select(backups.c.id, backups.c.host, backups.c.last_seen_at, backups.c.config)
        .order_by(backups.c.id)
    ).all()

    kept = {}  # host -> (id, hash, last_seen_at) of the newest backup kept so far
    for backup_id, host, last_seen_at, config in rows:
        digest = config_hash(config)
        previous = kept.get(host)
        if previous is not None and previous[1] == digest:
            # Same configuration as the backup before it: keep the earlier
            # one and let it cover the time the duplicate was seen.
            last_seen_at = max(previous[2], last_seen_at)
            connection.execute(
                backups.update().where(backups.c.id == previous[0]).values(last_seen_at=last_seen_at)
            )
            connection.execute(backups.delete().where(backups.c.id == backup_id))
            kept[host] = (previous[0], digest, last_seen_at)
        else:
            connection.execute(
                backups.update().where(backups.c.id == backup_id).values(sha256=digest)
            )
            kept[host] = (backup_id, digest, last_seen_at)


def downgrade() -> None:
    """Nothing to undo: merged duplicates held no information of their own."""
