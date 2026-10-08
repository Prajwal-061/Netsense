"""device virtualization and type source

Virtualisation becomes its own device attribute instead of a device type,
and a device records where its type came from (a scan guess, or a login).
Collections keep the "show version" output.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-08

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from app.engine.discovery import lookup_vendor, lookup_virtualization

# revision identifiers, used by Alembic.
revision: str = '0004'
down_revision: Union[str, Sequence[str], None] = '0003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

devices = sa.table(
    'devices',
    sa.column('id', sa.Integer),
    sa.column('mac', sa.String),
    sa.column('vendor', sa.String),
    sa.column('virtualization', sa.String),
    sa.column('device_type', sa.String),
    sa.column('type_reason', sa.Text),
)
scan_results = sa.table(
    'scan_results',
    sa.column('id', sa.Integer),
    sa.column('device_id', sa.Integer),
    sa.column('reason', sa.Text),
)


def upgrade() -> None:
    # server_default fills the new NOT NULL columns for rows that already exist.
    with op.batch_alter_table('devices', schema=None) as batch_op:
        batch_op.add_column(sa.Column('virtualization', sa.String(length=32), nullable=True))
        batch_op.add_column(
            sa.Column('type_source', sa.String(length=16), nullable=False, server_default='scan')
        )
        batch_op.add_column(sa.Column('type_reason', sa.Text(), nullable=False, server_default=''))
    with op.batch_alter_table('device_collections', schema=None) as batch_op:
        batch_op.add_column(sa.Column('version', sa.JSON(), nullable=True))

    # Bring existing devices in line. Past scan results are history and are
    # left as they were recorded.
    connection = op.get_bind()
    rows = connection.execute(sa.select(devices.c.id, devices.c.mac, devices.c.device_type)).all()
    for device_id, mac, device_type in rows:
        virtualization = lookup_virtualization(mac)
        reason = connection.execute(
            sa.select(scan_results.c.reason)
            .where(scan_results.c.device_id == device_id)
            .order_by(scan_results.c.id.desc())
            .limit(1)
        ).scalar() or ''
        if device_type == 'VMware/virtual':
            # No longer a type: it only ever meant "virtual, otherwise unknown".
            device_type = 'unknown'
            reason = 'only a virtual MAC address is known; scan again to classify'
        connection.execute(
            devices.update()
            .where(devices.c.id == device_id)
            .values(
                vendor=lookup_vendor(mac),
                virtualization=virtualization,
                device_type=device_type,
                type_reason=reason,
            )
        )


def downgrade() -> None:
    with op.batch_alter_table('device_collections', schema=None) as batch_op:
        batch_op.drop_column('version')
    with op.batch_alter_table('devices', schema=None) as batch_op:
        batch_op.drop_column('type_reason')
        batch_op.drop_column('type_source')
        batch_op.drop_column('virtualization')
