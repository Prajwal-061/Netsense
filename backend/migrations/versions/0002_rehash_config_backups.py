"""hash config backups by their normalised text

Config backups are now compared ignoring lines that change without a config
change (timestamps, byte count). This recomputes the stored hash of existing
backups the same way. The config text itself is not touched.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-08

"""
import hashlib
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from app.engine.config_diff import config_hash

# revision identifiers, used by Alembic.
revision: str = '0002'
down_revision: Union[str, Sequence[str], None] = '0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

backups = sa.table(
    'config_backups',
    sa.column('id', sa.Integer),
    sa.column('sha256', sa.String),
    sa.column('config', sa.Text),
)


def _rehash(hash_function) -> None:
    connection = op.get_bind()
    for backup_id, config in connection.execute(sa.select(backups.c.id, backups.c.config)).all():
        connection.execute(
            backups.update().where(backups.c.id == backup_id).values(sha256=hash_function(config))
        )


def upgrade() -> None:
    """Hash of the normalised config."""
    _rehash(config_hash)


def downgrade() -> None:
    """Back to the hash of the raw config."""
    _rehash(lambda config: hashlib.sha256(config.encode()).hexdigest())
