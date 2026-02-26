"""Internal link CRUD endpoints, nested under profiles."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_session
from src.models.link import InternalLink
from src.models.profile import WebsiteProfile
from src.models.schemas import LinkCreate, LinkRead

router = APIRouter(prefix="/api/profiles/{profile_id}/links", tags=["links"])


async def _get_profile_or_404(
    profile_id: uuid.UUID, session: AsyncSession
) -> WebsiteProfile:
    profile = await session.get(WebsiteProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    return profile


@router.get("", response_model=dict)
async def list_links(
    profile_id: uuid.UUID,
    q: str | None = Query(None, description="Search by URL or title"),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    session: AsyncSession = Depends(get_session),
):
    await _get_profile_or_404(profile_id, session)

    query = select(InternalLink).where(InternalLink.profile_id == profile_id)

    if q:
        pattern = f"%{q}%"
        query = query.where(
            InternalLink.url.ilike(pattern) | InternalLink.title.ilike(pattern)
        )

    # Total count
    count_query = select(func.count()).select_from(query.subquery())
    total = (await session.execute(count_query)).scalar_one()

    # Paginated results
    query = query.order_by(InternalLink.created_at.desc())
    query = query.offset((page - 1) * per_page).limit(per_page)
    result = await session.execute(query)
    links = result.scalars().all()

    return {
        "items": [LinkRead.model_validate(link) for link in links],
        "total": total,
        "page": page,
        "per_page": per_page,
        "pages": (total + per_page - 1) // per_page if total > 0 else 0,
    }


@router.post("", response_model=LinkRead, status_code=201)
async def create_link(
    profile_id: uuid.UUID,
    data: LinkCreate,
    session: AsyncSession = Depends(get_session),
):
    await _get_profile_or_404(profile_id, session)

    # Check for duplicate URL
    existing = await session.execute(
        select(InternalLink).where(
            InternalLink.profile_id == profile_id,
            InternalLink.url == data.url,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=409, detail="Link with this URL already exists for this profile"
        )

    link = InternalLink(profile_id=profile_id, source="manual", **data.model_dump())
    session.add(link)
    await session.commit()
    await session.refresh(link)
    return link


@router.delete("/{link_id}", status_code=204)
async def delete_link(
    profile_id: uuid.UUID,
    link_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
):
    link = await session.execute(
        select(InternalLink).where(
            InternalLink.id == link_id,
            InternalLink.profile_id == profile_id,
        )
    )
    link = link.scalar_one_or_none()
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")

    await session.delete(link)
    await session.commit()
