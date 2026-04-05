import { Body, Controller, Post } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/isPublic.decorator';
import { SpendDto } from './dto/spend.dto';
import { SpendResponseDto } from './dto/spend-response.dto';
import { SpendService } from './spend.service';

@ApiTags('Spend')
@Controller('spend')
export class SpendController {
  constructor(private readonly spendService: SpendService) {}

  @Public()
  @Post()
  @ApiOkResponse({ type: SpendResponseDto, description: 'Tokens spent successfully' })
  spend(@Body() dto: SpendDto) {
    return this.spendService.spend(dto);
  }
}
