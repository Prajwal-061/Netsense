"""store the computed topology with each network collection

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-09

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0006'
down_revision: Union[str, Sequence[str], None] = '0005'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable: runs from before this revision get theirs computed on first use.
    with op.batch_alter_table('network_collections', schema=None) as batch_op:
        batch_op.add_column(sa.Column('topology', sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('network_collections', schema=None) as batch_op:
        batch_op.drop_column('topology')
