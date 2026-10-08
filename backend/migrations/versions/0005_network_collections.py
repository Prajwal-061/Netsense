"""network collections

Collections can now cover every network device in one run. A device
collection belongs to a run, records success or failure, and keeps all
command outputs in one JSON document ("data") instead of a column per
command. The existing interface, VLAN, MAC table and version columns are
moved into that document.

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-08

"""
import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0005'
down_revision: Union[str, Sequence[str], None] = '0004'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

OLD_COLUMNS = ('interfaces', 'vlans', 'mac_table', 'version')


def upgrade() -> None:
    op.create_table(
        'network_collections',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    # server_default fills the new NOT NULL columns for rows that already exist.
    with op.batch_alter_table('device_collections', schema=None) as batch_op:
        batch_op.add_column(sa.Column('network_collection_id', sa.Integer(), nullable=True))
        batch_op.add_column(
            sa.Column('status', sa.String(length=16), nullable=False, server_default='success')
        )
        batch_op.add_column(sa.Column('error', sa.Text(), nullable=True))
        batch_op.add_column(sa.Column('note', sa.Text(), nullable=True))
        batch_op.add_column(sa.Column('data', sa.JSON(), nullable=False, server_default='{}'))
        batch_op.add_column(sa.Column('config_backup_id', sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column('config_changed', sa.Boolean(), nullable=True))
        batch_op.create_index(
            batch_op.f('ix_device_collections_network_collection_id'),
            ['network_collection_id'],
            unique=False,
        )
        batch_op.create_foreign_key(
            'fk_device_collections_network_collection',
            'network_collections',
            ['network_collection_id'],
            ['id'],
            ondelete='CASCADE',
        )
        batch_op.create_foreign_key(
            'fk_device_collections_config_backup', 'config_backups', ['config_backup_id'], ['id']
        )

    # Move the per-command columns into the data document. Read and written
    # as text so that this works the same on SQLite and PostgreSQL.
    connection = op.get_bind()
    columns = ', '.join(f'CAST({name} AS TEXT)' for name in OLD_COLUMNS)
    rows = connection.execute(sa.text(f'SELECT id, {columns} FROM device_collections')).all()
    for row in rows:
        data = {
            name: json.loads(value)
            for name, value in zip(OLD_COLUMNS, row[1:])
            if value is not None and json.loads(value) is not None
        }
        connection.execute(
            sa.text('UPDATE device_collections SET data = :data WHERE id = :id'),
            {'data': json.dumps(data), 'id': row[0]},
        )

    with op.batch_alter_table('device_collections', schema=None) as batch_op:
        for name in OLD_COLUMNS:
            batch_op.drop_column(name)


def downgrade() -> None:
    with op.batch_alter_table('device_collections', schema=None) as batch_op:
        for name in OLD_COLUMNS:
            batch_op.add_column(sa.Column(name, sa.JSON(), nullable=True))

    connection = op.get_bind()
    rows = connection.execute(
        sa.text('SELECT id, CAST(data AS TEXT) FROM device_collections')
    ).all()
    for collection_id, data in rows:
        data = json.loads(data) if data else {}
        values = {name: json.dumps(data.get(name, [] if name != 'version' else None)) for name in OLD_COLUMNS}
        connection.execute(
            sa.text(
                'UPDATE device_collections SET interfaces = :interfaces, vlans = :vlans, '
                'mac_table = :mac_table, version = :version WHERE id = :id'
            ),
            {**values, 'id': collection_id},
        )

    with op.batch_alter_table('device_collections', schema=None) as batch_op:
        batch_op.drop_constraint('fk_device_collections_config_backup', type_='foreignkey')
        batch_op.drop_constraint('fk_device_collections_network_collection', type_='foreignkey')
        batch_op.drop_index(batch_op.f('ix_device_collections_network_collection_id'))
        for name in ('config_changed', 'config_backup_id', 'data', 'note', 'error', 'status', 'network_collection_id'):
            batch_op.drop_column(name)
    op.drop_table('network_collections')
