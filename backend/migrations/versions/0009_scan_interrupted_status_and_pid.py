"""scan interrupted status and pid

Scans cut off before they finished get their own status, "interrupted",
instead of "failed" (or, after a race between two processes, "completed").
Existing scans whose error says they were interrupted are moved to it; their
results, if any, are kept. Each scan also records the process running it.

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-26

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0009'
down_revision: Union[str, Sequence[str], None] = '0008'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

scans = sa.table('scans', sa.column('status', sa.String), sa.column('error', sa.Text))


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table('scans', schema=None) as batch_op:
        batch_op.add_column(sa.Column('pid', sa.Integer(), nullable=True))
    op.execute(
        scans.update()
        .where(scans.c.error.like('Interrupted:%'), scans.c.status != 'interrupted')
        .values(status='interrupted')
    )


def downgrade() -> None:
    """Downgrade schema."""
    # The old code knew no "interrupted": such a scan was a failed one.
    op.execute(scans.update().where(scans.c.status == 'interrupted').values(status='failed'))
    with op.batch_alter_table('scans', schema=None) as batch_op:
        batch_op.drop_column('pid')
